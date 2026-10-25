import "server-only";

import { Prisma, RegistrationMode, RsvpStatus } from "@prisma/client";
import { z } from "zod";
import { captureSubmissionSnapshotTx, restoreSubmissionSnapshotTx, submissionSnapshotSchema } from "@/lib/core/submissionLifecycle";
import { countConfirmedUnits, promoteOldestWaitlistedUnit, rsvpWebhookSnapshot } from "@/lib/teamUnits";
import { CHECK_IN_LIST_SOURCES, MAX_CHECK_IN_LISTS } from "@/lib/checkInLists";
import { teamTokenSchema } from "@/lib/validators";
import { fail, isUniqueViolation, lockEvent, TEAM_NOT_FOUND, teamTransaction, type OrganiserEventContext, type TeamResult } from "./shared";

/** Whole-team deletion with a short-lived undo snapshot, and its restore. */

const UNDO_TTL_MS = 5 * 60_000;

const teamSnapshotRsvpSchema = z.object({
  id: z.string().min(1).max(128),
  userId: z.string().min(1).nullable(),
  guestEmail: z.string().email().nullable(),
  guestName: z.string().max(200).nullable(),
  attendeeKey: z.string().min(1).max(512),
  checkInToken: z.string().min(8).max(256),
  checkedInAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  answers: z.array(z.object({
    fieldId: z.string().min(1),
    valueText: z.string().nullable(),
    valueBool: z.boolean().nullable(),
    valueNumber: z.number().finite().nullable(),
    valueDate: z.string().datetime().nullable(),
  })).max(200),
  /** Custom check-in list records (same shape as the single-RSVP undo); optional for older snapshots. */
  listCheckIns: z.array(z.object({
    listId: z.string().min(1).max(128),
    checkedInAt: z.string().datetime(),
    source: z.enum(CHECK_IN_LIST_SOURCES),
  })).max(MAX_CHECK_IN_LISTS).optional(),
});

const teamDeletionSnapshotSchema = z.object({
  kind: z.literal("team"),
  eventId: z.string().min(1).max(128),
  team: z.object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(200),
    nameKey: z.string().min(1).max(200),
    status: z.nativeEnum(RsvpStatus),
    joinToken: teamTokenSchema,
    manageTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    leaderRsvpId: z.string().min(1).max(128).nullable(),
    lookingForMembers: z.boolean(),
    createdAt: z.string().datetime(),
  }),
  rsvps: z.array(teamSnapshotRsvpSchema).min(1).max(200),
  /** The team's project and its judging record, recreated on undo. Absent in older snapshots. */
  submission: submissionSnapshotSchema.nullable().optional(),
});

/** True when an undo row holds a whole-team deletion (see `organiserDeleteTeam`). */
export function isTeamDeletionSnapshot(payload: unknown): boolean {
  return typeof payload === "object" && payload !== null && (payload as { kind?: unknown }).kind === "team";
}

const teamSnapshotInclude = {
  members: {
    include: { answers: true, checkInListRecords: { select: { listId: true, checkedInAt: true, source: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.TeamInclude;

type TeamWithSnapshotMembers = Prisma.TeamGetPayload<{ include: typeof teamSnapshotInclude }>;

/**
 * The whole-team undo payload restored by `restoreTeamDeletionSnapshot`,
 * including the team's project with its scores, reviews, assignments, and
 * award places, which the deletion cascades away.
 */
async function teamDeletionSnapshot(tx: Prisma.TransactionClient, team: TeamWithSnapshotMembers, eventId: string) {
  const submission = await captureSubmissionSnapshotTx(tx, { eventId, teamId: team.id });
  return {
    kind: "team" as const,
    eventId,
    team: {
      id: team.id,
      name: team.name,
      nameKey: team.nameKey,
      status: team.status,
      joinToken: team.joinToken,
      manageTokenHash: team.manageTokenHash,
      leaderRsvpId: team.leaderRsvpId,
      lookingForMembers: team.lookingForMembers,
      createdAt: team.createdAt.toISOString(),
    },
    rsvps: team.members.map((rsvp) => ({
      id: rsvp.id,
      userId: rsvp.userId,
      guestEmail: rsvp.guestEmail,
      guestName: rsvp.guestName,
      attendeeKey: rsvp.attendeeKey,
      checkInToken: rsvp.checkInToken,
      checkedInAt: rsvp.checkedInAt?.toISOString() ?? null,
      createdAt: rsvp.createdAt.toISOString(),
      answers: rsvp.answers.map((answer) => ({
        fieldId: answer.fieldId,
        valueText: answer.valueText,
        valueBool: answer.valueBool,
        valueNumber: answer.valueNumber,
        valueDate: answer.valueDate?.toISOString() ?? null,
      })),
      listCheckIns: rsvp.checkInListRecords.map((record) => ({
        listId: record.listId,
        checkedInAt: record.checkedInAt.toISOString(),
        source: record.source,
      })),
    })),
    submission,
  };
}

/**
 * Inside a transaction that already holds the Event lock: when `rsvpId` is the
 * only member of its team, the whole-team undo payload, so deleting that one
 * registration (which also deletes the emptied team) can be undone by
 * recreating the team. Null when the team has other members.
 */
export async function soleMemberTeamSnapshotTx(
  tx: Prisma.TransactionClient,
  params: { teamId: string; eventId: string; rsvpId: string },
) {
  const team = await tx.team.findFirst({ where: { id: params.teamId, eventId: params.eventId }, include: teamSnapshotInclude });
  if (!team || team.members.length !== 1 || team.members[0]!.id !== params.rsvpId) return null;
  return teamDeletionSnapshot(tx, team, params.eventId);
}

/**
 * Delete a whole team and its member registrations, keeping a short-lived,
 * server-created undo snapshot (the existing RsvpDeletionUndo pattern). A
 * confirmed team frees its unit and promotes the oldest waitlisted unit.
 */
export async function organiserDeleteTeam(ctx: OrganiserEventContext, teamId: string): Promise<TeamResult<{ undoId: string; removed: number }>> {
  if (!teamId || teamId.length > 128) return fail(TEAM_NOT_FOUND);
  return teamTransaction(async (tx, webhooks): Promise<TeamResult<{ undoId: string; removed: number }>> => {
    const event = await lockEvent(tx, ctx.eventId);
    if (!event || event.organisationId !== ctx.organisationId) return fail("Event not found.");
    const team = await tx.team.findFirst({
      where: { id: teamId, eventId: event.id },
      include: teamSnapshotInclude,
    });
    if (!team) return fail(TEAM_NOT_FOUND);
    const snapshot = await teamDeletionSnapshot(tx, team, event.id);
    await tx.rsvpDeletionUndo.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    // An empty team (should not exist) is deleted without an undo snapshot.
    const undo = snapshot.rsvps.length > 0
      ? await tx.rsvpDeletionUndo.create({
        data: {
          organisationId: ctx.organisationId,
          deletedByUserId: ctx.userId,
          payload: snapshot as Prisma.InputJsonValue,
          expiresAt: new Date(Date.now() + UNDO_TTL_MS),
        },
        select: { id: true },
      })
      : null;
    const removed = await tx.rSVP.deleteMany({ where: { teamId: team.id, eventId: event.id } });
    await tx.team.delete({ where: { id: team.id } });
    for (const member of team.members) {
      webhooks.push({ type: "registration.status_changed", rsvpId: member.id, status: "REMOVED", previousStatus: member.status, snapshot: rsvpWebhookSnapshot(member) });
    }
    if (team.status === RsvpStatus.CONFIRMED) webhooks.push(...((await promoteOldestWaitlistedUnit(tx, event))?.webhooks ?? []));
    return { ok: true, data: { undoId: undo?.id ?? "", removed: removed.count } };
  });
}

/**
 * Restore a team deleted by `organiserDeleteTeam`. Called by
 * `restoreRsvpForUser` after it has matched the undo row to the organiser and
 * organisation. The name must still be free and, for a confirmed team, a unit
 * must still be free.
 */
export async function restoreTeamDeletionSnapshot(
  undo: { id: string; payload: unknown },
  organisationId: string,
): Promise<TeamResult<{ eventId: string; eventSlug: string; teamId: string }>> {
  const snapshot = teamDeletionSnapshotSchema.safeParse(undo.payload);
  if (!snapshot.success) return fail("Could not restore this team safely.");
  const data = snapshot.data;
  try {
    return await teamTransaction(async (tx, webhooks): Promise<TeamResult<{ eventId: string; eventSlug: string; teamId: string }>> => {
      const event = await lockEvent(tx, data.eventId);
      if (!event || event.organisationId !== organisationId) return fail("The original event no longer exists.");
      if (event.registrationMode !== RegistrationMode.TEAM) return fail("This event no longer uses team registration.");
      const taken = await tx.team.findUnique({ where: { eventId_nameKey: { eventId: event.id, nameKey: data.team.nameKey } }, select: { id: true } });
      if (taken) return fail("Another team now uses this name, so it can't be restored.");
      if (event.teamMaxSize == null || data.rsvps.length > event.teamMaxSize) return fail("This team is now larger than the maximum team size.");
      if (data.team.status === RsvpStatus.CONFIRMED && event.capacity != null && (await countConfirmedUnits(tx, event.id)) >= event.capacity) {
        return fail("This team cannot be restored because the event is now at capacity.");
      }
      await tx.team.create({
        data: {
          id: data.team.id,
          eventId: event.id,
          name: data.team.name,
          nameKey: data.team.nameKey,
          status: data.team.status,
          joinToken: data.team.joinToken,
          manageTokenHash: data.team.manageTokenHash,
          lookingForMembers: data.team.lookingForMembers,
          createdAt: new Date(data.team.createdAt),
        },
      });
      for (const rsvp of data.rsvps) {
        await tx.rSVP.create({
          data: {
            id: rsvp.id,
            eventId: event.id,
            userId: rsvp.userId,
            guestEmail: rsvp.guestEmail,
            guestName: rsvp.guestName,
            status: data.team.status,
            attendeeKey: rsvp.attendeeKey,
            checkInToken: rsvp.checkInToken,
            checkedInAt: rsvp.checkedInAt ? new Date(rsvp.checkedInAt) : null,
            createdAt: new Date(rsvp.createdAt),
            teamId: data.team.id,
            answers: { create: rsvp.answers.map((answer) => ({
              fieldId: answer.fieldId,
              valueText: answer.valueText,
              valueBool: answer.valueBool,
              valueNumber: answer.valueNumber,
              valueDate: answer.valueDate ? new Date(answer.valueDate) : null,
            })) },
          },
        });
        webhooks.push({ type: "registration.status_changed", rsvpId: rsvp.id, status: data.team.status, previousStatus: "REMOVED" });
      }
      // Custom check-in list records, exactly as the single-RSVP undo restores
      // them: only lists that still belong to this event; history is not rewritten.
      const listCheckIns = data.rsvps.flatMap((rsvp) => (rsvp.listCheckIns ?? []).map((entry) => ({ ...entry, rsvpId: rsvp.id })));
      if (listCheckIns.length > 0) {
        const lists = await tx.checkInList.findMany({ where: { eventId: event.id, id: { in: [...new Set(listCheckIns.map((entry) => entry.listId))] } }, select: { id: true } });
        const live = new Set(lists.map((list) => list.id));
        await tx.checkInListRecord.createMany({
          data: listCheckIns.filter((entry) => live.has(entry.listId)).map((entry) => ({
            listId: entry.listId,
            rsvpId: entry.rsvpId,
            source: entry.source,
            checkedInAt: new Date(entry.checkedInAt),
          })),
          skipDuplicates: true,
        });
      }
      const leaderRsvpId = data.team.leaderRsvpId && data.rsvps.some((rsvp) => rsvp.id === data.team.leaderRsvpId)
        ? data.team.leaderRsvpId
        : data.rsvps[0]!.id;
      await tx.team.update({ where: { id: data.team.id }, data: { leaderRsvpId } });
      if (data.submission) await restoreSubmissionSnapshotTx(tx, data.submission, { eventId: event.id, teamId: data.team.id });
      await tx.rsvpDeletionUndo.delete({ where: { id: undo.id } });
      return { ok: true, data: { eventId: event.id, eventSlug: event.slug, teamId: data.team.id } };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("This team can no longer be restored because a conflicting registration exists.");
    console.error("[teams] restore failed");
    return fail("Could not restore the team.");
  }
}
