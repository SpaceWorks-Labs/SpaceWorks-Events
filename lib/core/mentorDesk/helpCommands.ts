import "server-only";

/*
 * Mentor and organiser help commands (help_workflow.command): claim, renew,
 * release, resolve (mentors on shift; release and resolve also organisers),
 * assign and reopen (organisers). Claims are leases: claimId + generation +
 * expiry, one live claim per mentor (partial unique index as the last word).
 */

import { HelpRequestStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { claimLeaseExpiry, helpDeadline, HELP_NOTE_MAX_LENGTH, HELP_PRIORITY_WINDOW_MS } from "@/lib/mentorDesk/rules";
import { HELP_CLAIMED_KIND, enqueueMentorMessages } from "@/lib/outbox/mentor";
import { deskEvent, liveMentor, type DeskOrganiserContext, type LockedEvent, type MentorContext } from "./access";
import { visitEligible } from "./eligibility";
import { changeHelp, claimValues, CLEARED_CLAIM, clearMentorClaims, type HelpRow, lockHelpRow, requireLive, requireStatus } from "./helpShared";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, refuse } from "./shared";

export type HelpAction = "claim" | "renew" | "release" | "resolve" | "assign" | "reopen";

const schema = z.object({
  requestId: z.string().min(1).max(128),
  action: z.enum(["claim", "renew", "release", "resolve", "assign", "reopen"]),
  expectedVersion: z.number().int().min(1),
  claimId: z.string().max(64).optional(),
  claimGeneration: z.number().int().min(1).optional(),
  mentorUserId: z.string().max(128).optional(),
  note: z.string().max(HELP_NOTE_MAX_LENGTH).optional().default(""),
});

type Input = z.infer<typeof schema>;
type Actor = MentorContext | DeskOrganiserContext;

/** Who gets the optional "a mentor is on the way" email: the raiser, else the team leader or registrant. */
async function claimedRecipient(tx: Prisma.TransactionClient, row: HelpRow): Promise<string | null> {
  if (row.raisedByUserId) {
    const user = await tx.user.findUnique({ where: { id: row.raisedByUserId }, select: { email: true } });
    if (user?.email) return user.email;
  }
  const rsvp = row.teamId
    ? (await tx.team.findUnique({ where: { id: row.teamId }, select: { leaderRsvp: { select: { guestEmail: true, user: { select: { email: true } } } } } }))?.leaderRsvp
    : await tx.rSVP.findUnique({ where: { id: row.rsvpId! }, select: { guestEmail: true, user: { select: { email: true } } } });
  return rsvp?.user?.email ?? rsvp?.guestEmail ?? null;
}

/** Takes the claim for `mentorUserId` (claim, or an organiser's assign). */
async function takeClaim(tx: Prisma.TransactionClient, event: LockedEvent, row: HelpRow, mentorUserId: string, actorUserId: string, kind: "claim" | "assign", now: Date) {
  const mentor = await liveMentor(tx, event.id, mentorUserId, { at: now });
  const eligible = await visitEligible(tx, { eventId: event.id, mentor, scope: row, skillTags: row.category.skillTags, priorityUntil: row.exclusiveUntil, now });
  if (!eligible) refuse(COPY.notEligible);
  await clearMentorClaims(tx, event.id, mentorUserId, row.id, event.endDateTime, now);
  const values = claimValues(row, event.endDateTime, now);
  await changeHelp(tx, row, {
    status: HelpRequestStatus.CLAIMED,
    claimedByUserId: mentorUserId,
    ...values,
    firstClaimedAt: row.firstClaimedAt ?? now,
    lastClaimedAt: now,
  }, { actorUserId, kind });
  // One optional email per request (its first claim), never per change.
  if (event.mentorHelpClaimedEmail && !row.firstClaimedAt) {
    const to = await claimedRecipient(tx, row);
    if (to) await enqueueMentorMessages(tx, HELP_CLAIMED_KIND, [{ to, id: row.id, generation: values.claimGeneration }]);
  }
}

async function apply(tx: Prisma.TransactionClient, actor: Actor, input: Input): Promise<void> {
  const event = await deskEvent(tx, actor);
  const isOrganiser = actor.kind === "organiser";
  if ((input.action === "assign" || input.action === "reopen") && !isOrganiser) refuse(COPY.notFound);
  if ((input.action === "claim" || input.action === "renew") && isOrganiser) refuse(COPY.notFound);
  const now = new Date();
  // Mentors act only while on shift (policy.mentor_for in every command).
  const self = isOrganiser ? null : await liveMentor(tx, event.id, actor.userId, { at: now });
  const row = await lockHelpRow(tx, event.id, input.requestId);
  if (!isOrganiser && (input.action === "release" || input.action === "resolve") && row.claimedByUserId !== actor.userId) refuse(COPY.notFound);
  checkVersion(row, input.expectedVersion);
  requireLive(row, event.endDateTime, now);
  switch (input.action) {
    case "claim":
      requireStatus(row, HelpRequestStatus.OPEN);
      return takeClaim(tx, event, row, actor.userId, actor.userId, "claim", now);
    case "assign": {
      requireStatus(row, HelpRequestStatus.OPEN, HelpRequestStatus.CLAIMED);
      if (!input.mentorUserId) refuse(COPY.invalid);
      await takeClaim(tx, event, row, input.mentorUserId, actor.userId, "assign", now);
      await recordAuditEvent({ client: tx, action: "MENTOR_HELP_ASSIGNED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: "HelpRequest", targetId: row.id });
      return;
    }
    case "renew": {
      requireStatus(row, HelpRequestStatus.CLAIMED);
      if (row.claimedByUserId !== actor.userId || row.claimId !== input.claimId || row.claimGeneration !== input.claimGeneration) refuse(COPY.leaseLost);
      if (!(await visitEligible(tx, { eventId: event.id, mentor: self!, scope: row, skillTags: row.category.skillTags, now }))) refuse(COPY.notEligible);
      const claimExpiresAt = claimLeaseExpiry(now, row.category.claimMinutes, helpDeadline(row.expiresAt, event.endDateTime));
      return changeHelp(tx, row, { claimExpiresAt }, { actorUserId: actor.userId, kind: "renew" });
    }
    case "release":
      requireStatus(row, HelpRequestStatus.CLAIMED);
      return changeHelp(tx, row, { status: HelpRequestStatus.OPEN, ...CLEARED_CLAIM, lastOpenedAt: now, openGeneration: row.openGeneration + 1 }, { actorUserId: actor.userId, kind: "release", note: input.note });
    case "resolve":
      requireStatus(row, HelpRequestStatus.CLAIMED);
      return changeHelp(tx, row, { status: HelpRequestStatus.RESOLVED, ...CLEARED_CLAIM, resolvedAt: now }, { actorUserId: actor.userId, kind: "resolve", note: input.note });
    case "reopen": {
      requireStatus(row, HelpRequestStatus.RESOLVED);
      if (!input.note.trim()) refuse(COPY.reasonRequired);
      await changeHelp(tx, row, { status: HelpRequestStatus.OPEN, resolvedAt: null, exclusiveUntil: new Date(now.getTime() + HELP_PRIORITY_WINDOW_MS), lastOpenedAt: now, openGeneration: row.openGeneration + 1 }, { actorUserId: actor.userId, kind: "reopen", note: input.note.trim() });
      await recordAuditEvent({ client: tx, action: "MENTOR_HELP_REOPENED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: "HelpRequest", targetId: row.id });
      return;
    }
  }
}

/** One help command. Two mentors claiming at once: the row lock serialises them and the loser sees a stale version. */
export async function helpCommand(actor: Actor, input: unknown): Promise<DeskResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    await apply(tx, actor, parsed.data);
    return undefined;
  }, COPY.busy);
}
