import "server-only";

/** Atomic MENTOR crew lifecycle (docs/MENTOR_DESK.md). No orders or attendee conversions. */
import { CrewKind, EventPermission, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addCrewMemberTx } from "@/lib/core/crew/members";
import { removeCrewMemberLocked } from "@/lib/core/crew/removal";
import { eventForCrewSelect, findRegistrationByEmail, linkCrewAccount } from "@/lib/core/crew/shared";
import { linkMentorCrew, lockCrewLinkPersons } from "@/lib/core/crew/identity";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import { lockEvent, refuse } from "./shared";

export type MentorGrantChange = { eventId: string; userId: string; before: readonly EventPermission[]; after: readonly EventPermission[]; actorUserId: string };

/** Queued crew emails reference Organisation too: fence it before Event and all subordinate locks. */
export async function lockMentorGrantEvent(tx: Prisma.TransactionClient, eventId: string) {
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { organisationId: true } });
  if (event) await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${event.organisationId} FOR KEY SHARE`;
  await lockEvent(tx, eventId);
}

/** Caller holds Event FOR UPDATE. Lock all current/proposed identities together before the grant. */
export async function lockMentorGrantPersons(tx: Prisma.TransactionClient, eventId: string, userId: string) {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  const email = user?.email?.trim().toLowerCase();
  const members = await tx.eventCrewMember.findMany({
    where: { eventId, OR: [{ mentorProfile: { userId } }, ...(email ? [{ email }] : [])] },
    select: { id: true },
  });
  await lockCrewLinkPersons(tx, eventId, members.map((m) => m.id), [userId]);
}

/**
 * In the grant transaction, after Event FOR UPDATE, people and the grant.
 * Ticket, queued mail and both identity links commit with the profile and
 * permissions. A refusal rolls everything back; emit the webhook after commit.
 */
export async function syncMentorCrewLocked(tx: Prisma.TransactionClient, change: MentorGrantChange): Promise<WebhookEmission | null> {
  const had = change.before.includes(EventPermission.MENTOR);
  const has = change.after.includes(EventPermission.MENTOR);
  if (has === had) return null;
  const profile = await tx.mentorProfile.findUnique({ where: { eventId_userId: { eventId: change.eventId, userId: change.userId } }, select: { id: true, crewMemberId: true } });
  if (!profile) return null;
  const event = await tx.event.findUnique({ where: { id: change.eventId }, select: { ...eventForCrewSelect, mentorsGetCrewTicket: true } });
  if (!event) return null;
  if (!has) {
    if (!profile.crewMemberId) return null;
    const removed = await removeCrewMemberLocked(tx, { organisationId: event.organisationId, eventId: event.id, actorUserId: change.actorUserId }, profile.crewMemberId);
    if (!removed.ok) refuse(removed.error);
    return removed.data.webhook;
  }
  if (profile.crewMemberId) return null;
  const user = await tx.user.findUnique({ where: { id: change.userId }, select: { name: true, email: true } });
  const email = user?.email?.trim().toLowerCase();
  if (!event.mentorsGetCrewTicket || !email) return null;
  if (await findRegistrationByEmail(tx, event.id, email)) {
    // Pre-existing tickets keep their owner and kind, and are never removed by this hook.
    await linkCrewAccount(tx, change.userId, email, event.id);
    return null;
  }
  const result = await addCrewMemberTx(event, { name: user?.name?.trim() || email, email, foodPreference: "", role: "Mentor", bio: "" }, { showOnPage: false, joinedViaLink: false, kind: CrewKind.MENTOR }, tx);
  if (!result.ok) refuse(result.error);
  // Ownership is recorded even when the account email is unverified.
  if (await linkMentorCrew(tx, event.id, change.userId, result.data.id) !== 1) refuse("The mentor crew place changed. Refresh and try again.");
  await linkCrewAccount(tx, change.userId, email, event.id);
  return result.data.webhook;
}

/** Standalone reconciliation; production grant changes use the locked helper. */
export async function syncMentorCrewAfterGrant(change: MentorGrantChange): Promise<void> {
  const webhook = await prisma.$transaction(async (tx) => {
    await lockMentorGrantEvent(tx, change.eventId);
    await lockMentorGrantPersons(tx, change.eventId, change.userId);
    return syncMentorCrewLocked(tx, change);
  });
  if (webhook) emitWebhookEvent(webhook);
}
