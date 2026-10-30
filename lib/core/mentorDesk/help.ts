import "server-only";

/*
 * The help queue (docs/MENTOR_DESK.md), ported from help_workflow.py:
 * raising a request (team, solo registration, or a mentor on a team's
 * behalf), the participant's cancel and rating, and comments. Mentor and
 * organiser commands are in ./helpCommands.ts; the beat's expiry in
 * ./helpExpiry.ts. Every command locks the row, checks the version and the
 * clock, then writes the change and an append-only activity row.
 */

import { HelpRequestOrigin, HelpRequestStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { HELP_COMMENT_MAX_LENGTH, HELP_LOCATION_MAX_LENGTH, HELP_PRIORITY_WINDOW_MS, HELP_SUMMARY_MAX_LENGTH, helpExpiresAt } from "@/lib/mentorDesk/rules";
import { deskEvent, liveMentor, liveParticipant, type MentorContext, type ParticipantContext } from "./access";
import { visitEligible, type HelpScope } from "./eligibility";
import { changeHelp, lockHelpRow, requireBeforeDeadline, requireLive, requireStatus } from "./helpShared";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockHelpEvent, lockTeam, refuse } from "./shared";

const raiseSchema = z.object({
  categoryKey: z.string().trim().min(1).max(40),
  summary: z.string().trim().min(1).max(HELP_SUMMARY_MAX_LENGTH),
  location: z.string().trim().max(HELP_LOCATION_MAX_LENGTH).optional().default(""),
});

/**
 * Creates a request inside the caller's transaction. Shared with round
 * triggers, which pass their own origin and dedup key and skip silently when
 * the open limit is reached.
 */
export async function createHelpLocked(tx: Prisma.TransactionClient, params: {
  event: { id: string; endDateTime: Date };
  scope: HelpScope;
  categoryKey: string;
  summary: string;
  location: string;
  origin: HelpRequestOrigin;
  raisedByUserId: string | null;
  roundId?: string | null;
  dedupKey?: string;
  now: Date;
  mentor?: { userId: string; skills: readonly string[] };
}): Promise<{ id: string } | "limit"> {
  // Callers also take this before any grant/round locks. Key-share matches
  // the insert's FK lock; assignments and answer editors wait at Event first.
  await lockHelpEvent(tx, params.event.id);
  const category = await tx.helpCategory.findFirst({ where: { eventId: params.event.id, key: params.categoryKey, active: true }, select: { id: true, priority: true, openLimit: true, expiryMinutes: true, skillTags: true } });
  if (!category) refuse(COPY.category);
  if (params.mentor && !(await visitEligible(tx, { eventId: params.event.id, mentor: params.mentor, scope: params.scope, skillTags: category.skillTags, now: params.now }))) refuse(COPY.notEligible);
  if (params.scope.teamId) await lockTeam(tx, params.scope.teamId);
  else await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${params.scope.rsvpId} FOR UPDATE`;
  const open = await tx.helpRequest.count({ where: { eventId: params.event.id, categoryId: category.id, teamId: params.scope.teamId, rsvpId: params.scope.rsvpId, status: { in: [HelpRequestStatus.OPEN, HelpRequestStatus.CLAIMED] } } });
  if (open >= category.openLimit) return "limit";
  const expiresAt = helpExpiresAt(params.now, category.expiryMinutes, params.event.endDateTime);
  if (expiresAt.getTime() <= params.now.getTime()) refuse(COPY.expired);
  const row = await tx.helpRequest.create({
    data: {
      eventId: params.event.id,
      categoryId: category.id,
      teamId: params.scope.teamId,
      rsvpId: params.scope.rsvpId,
      raisedByUserId: params.raisedByUserId,
      origin: params.origin,
      roundId: params.roundId ?? null,
      summary: params.summary,
      location: params.location,
      priority: category.priority,
      exclusiveUntil: new Date(params.now.getTime() + HELP_PRIORITY_WINDOW_MS),
      expiresAt,
      lastOpenedAt: params.now,
      dedupKey: params.dedupKey ?? "",
    },
    select: { id: true, eventId: true },
  });
  await tx.helpRequestActivity.create({ data: { requestId: row.id, eventId: row.eventId, actorUserId: params.raisedByUserId, kind: params.origin === HelpRequestOrigin.ROUND ? "round_triggered" : "raised" } });
  return { id: row.id };
}

/** A participant (signed-in confirmed registrant, or the team management link) asks for help. */
export async function raiseHelp(p: ParticipantContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = raiseSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    await lockHelpEvent(tx, p.eventId);
    const event = await deskEvent(tx, p);
    const scope = await liveParticipant(tx, p);
    const created = await createHelpLocked(tx, { event: { id: event.id, endDateTime: event.endDateTime }, scope, ...parsed.data, origin: HelpRequestOrigin.TEAM, raisedByUserId: p.userId, now: new Date() });
    if (created === "limit") refuse(COPY.limit);
    return created;
  });
}

/** A mentor raises a request on a team's behalf (origin MENTOR); the mentor must be eligible for the team and category. */
export async function raiseHelpAsMentor(m: MentorContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = raiseSchema.extend({ teamId: z.string().min(1).max(128) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    await lockHelpEvent(tx, m.eventId);
    const event = await deskEvent(tx, m);
    const now = new Date();
    const mentor = await liveMentor(tx, event.id, m.userId, { at: now });
    const team = await tx.team.findFirst({ where: { id: parsed.data.teamId, eventId: event.id, status: "CONFIRMED" }, select: { id: true } });
    if (!team) refuse(COPY.notFound);
    const created = await createHelpLocked(tx, { event, scope: { teamId: team.id, rsvpId: null }, categoryKey: parsed.data.categoryKey, summary: parsed.data.summary, location: parsed.data.location, origin: HelpRequestOrigin.MENTOR, raisedByUserId: m.userId, now, mentor });
    if (created === "limit") refuse(COPY.limit);
    return created;
  });
}

const commandSchema = z.object({ requestId: z.string().min(1).max(128), expectedVersion: z.number().int().min(1) });

/** The participant's own request, locked: a team's or the solo registration's. */
async function ownRequest(tx: Prisma.TransactionClient, p: ParticipantContext, requestId: string) {
  const scope = await liveParticipant(tx, p);
  const row = await lockHelpRow(tx, p.eventId, requestId);
  if (row.teamId !== scope.teamId || row.rsvpId !== scope.rsvpId) refuse(COPY.notFound);
  return row;
}

/** The team cancels an open or claimed request. */
export async function cancelHelp(p: ParticipantContext, input: unknown): Promise<DeskResult> {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, p, { allowDisabled: true });
    const row = await ownRequest(tx, p, parsed.data.requestId);
    checkVersion(row, parsed.data.expectedVersion);
    const now = new Date();
    requireBeforeDeadline(row, event.endDateTime, now);
    requireStatus(row, HelpRequestStatus.OPEN, HelpRequestStatus.CLAIMED);
    await changeHelp(tx, row, { status: HelpRequestStatus.CANCELLED, claimedByUserId: null, claimId: null, claimExpiresAt: null, cancelledAt: now }, { actorUserId: p.userId, kind: "cancel" });
    return undefined;
  });
}

/** The team rates a resolved request once, 1 to 5. */
export async function rateHelp(p: ParticipantContext, input: unknown): Promise<DeskResult> {
  const parsed = z.object({ requestId: z.string().min(1).max(128), rating: z.number().int().min(1).max(5) }).safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    await deskEvent(tx, p, { allowDisabled: true });
    const row = await ownRequest(tx, p, parsed.data.requestId);
    if (row.status !== HelpRequestStatus.RESOLVED || row.rating !== null) refuse(COPY.stale);
    await changeHelp(tx, row, { rating: parsed.data.rating }, { actorUserId: p.userId, kind: "rated" });
    return undefined;
  });
}

const commentSchema = commandSchema.extend({ body: z.string().max(HELP_COMMENT_MAX_LENGTH) });

/** help_workflow.comment: open or claimed, before the deadline; a comment never extends it. */
async function addComment(tx: Prisma.TransactionClient, row: Awaited<ReturnType<typeof lockHelpRow>>, eventEnd: Date, input: z.infer<typeof commentSchema>, author: { userId: string | null; origin: "TEAM" | "MENTOR" }) {
  checkVersion(row, input.expectedVersion);
  if (row.status !== HelpRequestStatus.OPEN && row.status !== HelpRequestStatus.CLAIMED) refuse(COPY.closed);
  requireLive(row, eventEnd, new Date());
  if (!input.body.trim()) refuse("Use 1–2000 characters.");
  await tx.helpRequest.update({ where: { id: row.id }, data: { version: { increment: 1 } } });
  await tx.helpRequestComment.create({ data: { requestId: row.id, eventId: row.eventId, authorUserId: author.userId, origin: author.origin, body: input.body.trim() } });
}

export async function commentAsParticipant(p: ParticipantContext, input: unknown): Promise<DeskResult> {
  const parsed = commentSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, p);
    const row = await ownRequest(tx, p, parsed.data.requestId);
    await addComment(tx, row, event.endDateTime, parsed.data, { userId: p.userId, origin: "TEAM" });
    return undefined;
  });
}

/** A mentor comments only on the request they hold a live claim on (help_workflow._detail_access). */
export async function commentAsMentor(m: MentorContext, input: unknown): Promise<DeskResult> {
  const parsed = commentSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, m);
    await liveMentor(tx, event.id, m.userId);
    const row = await lockHelpRow(tx, event.id, parsed.data.requestId);
    if (row.claimedByUserId !== m.userId) refuse(COPY.notFound);
    await addComment(tx, row, event.endDateTime, parsed.data, { userId: m.userId, origin: "MENTOR" });
    return undefined;
  });
}
