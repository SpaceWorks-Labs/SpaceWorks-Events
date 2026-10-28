import { Prisma, RsvpStatus } from "@prisma/client";
import { promoteOldestWaitlistedUnit, settleTeamAfterMemberLeft, teamPlacesTaken, type RegistrationStatusWebhook } from "@/lib/teamUnits";
import { soleMemberTeamSnapshotTx } from "@/lib/core/teams";
import { submissionSnapshotSchema } from "@/lib/core/submissionLifecycle";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { z } from "zod";
import { CHECK_IN_LIST_SOURCES, MAX_CHECK_IN_LISTS } from "@/lib/checkInLists";

export const revalidatePath = trackedRevalidation(nextRevalidatePath);

export const UNDO_TTL_MS = 5 * 60_000;

export const snapshotSchema = z.object({
  eventId: z.string().min(1).nullable(),
  eventInstanceId: z.string().min(1).nullable(),
  userId: z.string().min(1).nullable(),
  guestEmail: z.string().email().nullable(),
  guestName: z.string().max(200).nullable(),
  status: z.nativeEnum(RsvpStatus),
  attendeeKey: z.string().min(1).max(512),
  checkInToken: z.string().min(8).max(256),
  checkedInAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /** Team the RSVP belonged to (TEAM events); restored into it only if it still exists with room. */
  teamId: z.string().min(1).max(128).nullable().optional(),
  /** A solo registrant's project and its judging record (docs/HACKATHON.md), recreated on undo. */
  submission: submissionSnapshotSchema.nullable().optional(),
  answers: z.array(z.object({
    fieldId: z.string().min(1),
    valueText: z.string().nullable(),
    valueBool: z.boolean().nullable(),
    valueNumber: z.number().finite().nullable(),
    valueDate: z.string().datetime().nullable(),
  })).max(200),
  /** Custom check-in list records, restored for lists that still belong to the event. */
  listCheckIns: z.array(z.object({
    listId: z.string().min(1).max(128),
    checkedInAt: z.string().datetime(),
    source: z.enum(CHECK_IN_LIST_SOURCES),
  })).max(MAX_CHECK_IN_LISTS).optional(),
}).refine(
  (value) => Boolean(value.eventId) !== Boolean(value.eventInstanceId),
  { message: "Invalid RSVP target." },
);

export function revalidateRsvpPaths(orgSlug: string, target: { eventId: string | null; eventInstanceId: string | null; eventSlug?: string; }) {
  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/dashboard/${orgSlug}`);
  if (target.eventId) {
    revalidatePath(`/dashboard/${orgSlug}/event/${target.eventId}`);
    if (target.eventSlug) revalidatePath(`/${orgSlug}/${target.eventSlug}`);
  }
  if (target.eventInstanceId) revalidatePath(`/${orgSlug}/i/${target.eventInstanceId}`);
}

/** Puts back a restored RSVP's custom check-in list records, for lists still on the same event. History is not rewritten. */
export async function restoreListCheckIns(tx: Prisma.TransactionClient, eventId: string | null, rsvpId: string, listCheckIns: z.infer<typeof snapshotSchema>["listCheckIns"]) {
  if (!eventId || !listCheckIns?.length) return;
  const lists = await tx.checkInList.findMany({ where: { eventId, id: { in: listCheckIns.map((entry) => entry.listId) } }, select: { id: true } });
  const live = new Set(lists.map((list) => list.id));
  await tx.checkInListRecord.createMany({
    data: listCheckIns.filter((entry) => live.has(entry.listId)).map((entry) => ({
      listId: entry.listId,
      rsvpId,
      source: entry.source,
      checkedInAt: new Date(entry.checkedInAt),
    })),
    skipDuplicates: true,
  });
}

/**
 * TEAM events (docs/TEAMS.md): under the shared Event lock, re-read the team.
 * The last member's removal also deletes the emptied team, so a member
 * snapshot could never be restored into it: the whole team is kept instead.
 */
export async function teamDeletionPayload(tx: Prisma.TransactionClient, params: { eventId: string; rsvpId: string; snapshot: { teamId?: string | null } & Record<string, unknown> }) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${params.eventId} FOR UPDATE`;
  const current = await tx.rSVP.findUnique({ where: { id: params.rsvpId }, select: { teamId: true } });
  const teamId = current?.teamId ?? null;
  params.snapshot.teamId = teamId;
  const teamSnapshot = teamId ? await soleMemberTeamSnapshotTx(tx, { teamId, eventId: params.eventId, rsvpId: params.rsvpId }) : null;
  return { teamId, payload: (teamSnapshot ?? params.snapshot) as Prisma.InputJsonValue };
}

/**
 * After a team member is removed: leadership passes on, an emptied team goes,
 * and a freed unit is offered. Returns the promotion's webhooks, one per
 * member, for the caller to emit after commit.
 */
export async function settleTeamAfterRemoval(tx: Prisma.TransactionClient, params: { eventId: string; teamId: string; rsvpId: string }): Promise<RegistrationStatusWebhook[]> {
  const settled = await settleTeamAfterMemberLeft(tx, { teamId: params.teamId, eventId: params.eventId, leftRsvpId: params.rsvpId });
  if (!settled.freedConfirmedUnit) return [];
  const event = await tx.event.findUnique({ where: { id: params.eventId }, select: { id: true, title: true, capacity: true, privacyType: true } });
  const promoted = event ? await promoteOldestWaitlistedUnit(tx, event) : null;
  return promoted?.webhooks ?? [];
}

/**
 * Restoring a team member: back into their team, taking its current status,
 * only if it still exists with room. Joining never uses a unit.
 */
export async function teamForRestore(tx: Prisma.TransactionClient, params: { eventId: string; teamId: string }) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${params.eventId} FOR UPDATE`;
  const team = await tx.team.findFirst({
    where: { id: params.teamId, eventId: params.eventId },
    select: { id: true, status: true, event: { select: { teamMaxSize: true } } },
  });
  if (!team || team.status === RsvpStatus.REJECTED || team.status === RsvpStatus.PENDING_PAYMENT || team.event.teamMaxSize == null) return null;
  if (await teamPlacesTaken(tx, team.id) >= team.event.teamMaxSize) return null;
  return { id: team.id, status: team.status };
}
