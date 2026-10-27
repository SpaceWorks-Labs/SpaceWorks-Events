import "server-only";

/*
 * Mentor Desk configuration (configuration_workflow.py): the event switch,
 * mentor profiles, help categories and conflicts. Times arrive as
 * datetime-local values in the event's timezone and are stored in UTC.
 */

import { EventPermission, MentorAssignmentStatus, MentorConflictKind, OfficeHourBookingStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { recordAuditEvent } from "@/lib/audit";
import { safeTimeZone, zonedInputToIso } from "@/lib/timeZone";
import {
  CONFLICT_REASON_MAX_LENGTH, coversInterval, HELP_CLAIM_MINUTES, HELP_EXPIRY_MINUTES, HELP_OPEN_LIMIT, HELP_PRIORITY_MAX, HELP_CATEGORIES_MAX,
  MENTOR_AFFILIATION_MAX_LENGTH, MENTOR_AVAILABILITY_MAX, MENTOR_BIO_MAX_LENGTH, MENTOR_MAX_TEAMS_MAX, MENTOR_MAX_TEAMS_MIN, MENTOR_SKILL_MAX_LENGTH, MENTOR_SKILLS_MAX,
  normaliseTags, windowsInsideEvent, type AvailabilityWindow,
} from "@/lib/mentorDesk/rules";
import { deskEvent, liveMentor, type DeskOrganiserContext, type MentorContext } from "./access";
import { COPY, checkVersion, type DeskResult, fail, inTransaction, lockEvent, okEmpty, refuse } from "./shared";

/** A datetime-local value in the event's zone as a Date, or null. */
export function localToDate(value: string, timeZone: string): Date | null {
  const iso = zonedInputToIso(value, safeTimeZone(timeZone));
  return iso ? new Date(iso) : null;
}

const settingsSchema = z.object({ mentorDeskEnabled: z.boolean(), mentorHelpClaimedEmail: z.boolean() }).strict();

/** The Mentor Desk switch and its optional email; owners and admins only. Switching off removes authority, never data. */
export async function updateDeskSettings(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const result = await inTransaction(async (tx) => {
    await lockEvent(tx, ctx.eventId);
    const event = await tx.event.updateMany({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, data: parsed.data });
    if (event.count !== 1) refuse(COPY.notFound);
    await recordAuditEvent({ client: tx, action: "MENTOR_DESK_SETTINGS_UPDATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { ...parsed.data } });
    return undefined;
  });
  return result.ok ? okEmpty() : result;
}

/** Creates the profile for a MENTOR grant (on invite acceptance or a grant change). Idempotent. */
export async function ensureMentorProfile(tx: Prisma.TransactionClient, eventId: string, userId: string) {
  await tx.mentorProfile.upsert({ where: { eventId_userId: { eventId, userId } }, create: { eventId, userId }, update: {} });
}

/**
 * assignment_workflow.end_role_locked: when a MENTOR grant goes, its live
 * mappings end, its claims return to the queue and its future bookings are
 * cancelled. The profile stays for history.
 */
export async function endMentorRoleLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, actorUserId: string) {
  const now = new Date();
  await tx.mentorTeamAssignment.updateMany({ where: { eventId, mentorUserId: userId, endedAt: null }, data: { status: MentorAssignmentStatus.ENDED, endedAt: now, version: { increment: 1 } } });
  const claimed = await tx.helpRequest.findMany({ where: { eventId, claimedByUserId: userId, status: "CLAIMED" }, select: { id: true, openGeneration: true } });
  for (const row of claimed) {
    await tx.helpRequest.update({ where: { id: row.id }, data: { status: "OPEN", claimedByUserId: null, claimId: null, claimExpiresAt: null, lastOpenedAt: now, openGeneration: row.openGeneration + 1, version: { increment: 1 } } });
    await tx.helpRequestActivity.create({ data: { requestId: row.id, eventId, actorUserId, kind: "role_ended" } });
  }
  await tx.officeHourBooking.updateMany({ where: { eventId, status: OfficeHourBookingStatus.BOOKED, slot: { mentorUserId: userId, startsAt: { gt: now } } }, data: { status: OfficeHourBookingStatus.CANCELLED, cancelledAt: now, cancelReason: "role_withdrawn" } });
}

/** Keeps profiles in step with a collaborator's grant change (inside the caller's transaction). */
export async function syncMentorGrantLocked(tx: Prisma.TransactionClient, eventId: string, userId: string, before: readonly EventPermission[], after: readonly EventPermission[], actorUserId: string) {
  const had = before.includes(EventPermission.MENTOR);
  const has = after.includes(EventPermission.MENTOR);
  if (has) await ensureMentorProfile(tx, eventId, userId);
  if (had && !has) await endMentorRoleLocked(tx, eventId, userId, actorUserId);
}

const windowInput = z.object({ start: z.string().max(20), end: z.string().max(20) });
const profileSchema = z.object({
  mentorUserId: z.string().min(1).max(128),
  expectedVersion: z.number().int().min(1),
  skills: z.array(z.string().trim().min(1).max(MENTOR_SKILL_MAX_LENGTH)).max(MENTOR_SKILLS_MAX).optional(),
  bio: z.string().trim().max(MENTOR_BIO_MAX_LENGTH).optional(),
  affiliation: z.string().trim().max(MENTOR_AFFILIATION_MAX_LENGTH).optional(),
  availability: z.array(windowInput).max(MENTOR_AVAILABILITY_MAX).optional(),
  maxActiveTeams: z.number().int().min(MENTOR_MAX_TEAMS_MIN).max(MENTOR_MAX_TEAMS_MAX).optional(),
  showOnPage: z.boolean().optional(),
}).strict();

/** A mentor edits their own profile (off shift is fine), or an organiser edits anyone's. */
export async function saveMentorProfile(actor: MentorContext | DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const data = parsed.data;
  if (actor.kind === "mentor" && data.mentorUserId !== actor.userId) return fail(COPY.notFound);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, actor, { allowDisabled: actor.kind === "organiser" });
    await liveMentor(tx, event.id, data.mentorUserId, { onShift: false });
    await tx.$queryRaw`SELECT "id" FROM "MentorProfile" WHERE "eventId" = ${event.id} AND "userId" = ${data.mentorUserId} FOR UPDATE`;
    const profile = await tx.mentorProfile.findUniqueOrThrow({ where: { eventId_userId: { eventId: event.id, userId: data.mentorUserId } } });
    checkVersion(profile, data.expectedVersion);
    let availability: AvailabilityWindow[] | undefined;
    if (data.availability) {
      availability = data.availability.map((w) => {
        const start = localToDate(w.start, event.timezone);
        const end = localToDate(w.end, event.timezone);
        if (!start || !end || start >= end) refuse("Choose intervals inside this event.");
        return { startsAt: start.toISOString(), endsAt: end.toISOString() };
      });
      if (!windowsInsideEvent(availability, event.startDateTime, event.endDateTime)) refuse("Choose intervals inside this event.");
      const bookings = await tx.officeHourSlot.findMany({ where: { eventId: event.id, mentorUserId: data.mentorUserId, cancelledAt: null, endsAt: { gt: new Date() }, bookings: { some: { status: OfficeHourBookingStatus.BOOKED } } }, select: { startsAt: true, endsAt: true } });
      if (bookings.some((slot) => !coversInterval(availability!, slot.startsAt, slot.endsAt))) refuse(COPY.activeBookings);
    }
    if (data.maxActiveTeams !== undefined) {
      const live = await tx.mentorTeamAssignment.count({ where: { eventId: event.id, mentorUserId: data.mentorUserId, endedAt: null } });
      if (live > data.maxActiveTeams) refuse("End assignments before reducing capacity.");
    }
    await tx.mentorProfile.update({
      where: { id: profile.id },
      data: {
        ...(data.skills ? { skills: normaliseTags(data.skills) } : {}),
        ...(data.bio !== undefined ? { bio: data.bio } : {}),
        ...(data.affiliation !== undefined ? { affiliation: data.affiliation } : {}),
        ...(availability ? { availability } : {}),
        ...(data.maxActiveTeams !== undefined ? { maxActiveTeams: data.maxActiveTeams } : {}),
        ...(data.showOnPage !== undefined ? { showOnPage: data.showOnPage } : {}),
        version: { increment: 1 },
      },
    });
    return undefined;
  });
}

const categorySchema = z.object({
  id: z.string().min(1).max(128).optional(),
  expectedVersion: z.number().int().min(0),
  key: z.string().trim().regex(/^[a-z0-9-]{1,40}$/),
  label: z.string().trim().min(1).max(100),
  skillTags: z.array(z.string().trim().min(1).max(MENTOR_SKILL_MAX_LENGTH)).max(MENTOR_SKILLS_MAX).default([]),
  priority: z.number().int().min(0).max(HELP_PRIORITY_MAX).default(0),
  openLimit: z.number().int().min(HELP_OPEN_LIMIT.min).max(HELP_OPEN_LIMIT.max).default(1),
  claimMinutes: z.number().int().min(HELP_CLAIM_MINUTES.min).max(HELP_CLAIM_MINUTES.max).default(10),
  expiryMinutes: z.number().int().min(HELP_EXPIRY_MINUTES.min).max(HELP_EXPIRY_MINUTES.max).default(240),
  contactNote: z.string().trim().max(300).default(""),
  active: z.boolean().default(true),
}).strict();

/** configuration_workflow.save_help_type: the key is fixed once created. */
export async function saveHelpCategory(ctx: DeskOrganiserContext, input: unknown): Promise<DeskResult<{ id: string }>> {
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const { id, expectedVersion, ...data } = parsed.data;
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, ctx, { allowDisabled: true });
    await lockEvent(tx, event.id);
    const values = { ...data, skillTags: normaliseTags(data.skillTags) };
    if (!id) {
      if (expectedVersion !== 0) refuse(COPY.stale);
      if ((await tx.helpCategory.count({ where: { eventId: event.id } })) >= HELP_CATEGORIES_MAX) refuse(`Use at most ${HELP_CATEGORIES_MAX} categories.`);
      const position = await tx.helpCategory.count({ where: { eventId: event.id } });
      return tx.helpCategory.create({ data: { ...values, eventId: event.id, position }, select: { id: true } });
    }
    const row = await tx.helpCategory.findFirst({ where: { id, eventId: event.id } });
    if (!row) refuse(COPY.notFound);
    checkVersion(row, expectedVersion);
    if (row.key !== values.key) refuse("A category key cannot change.");
    return tx.helpCategory.update({ where: { id }, data: { ...values, version: { increment: 1 } }, select: { id: true } });
  }, "This category key is already in use.");
}

const conflictSchema = z.object({
  mentorUserId: z.string().min(1).max(128),
  teamId: z.string().min(1).max(128),
  kind: z.nativeEnum(MentorConflictKind),
  active: z.boolean(),
  reason: z.string().trim().max(CONFLICT_REASON_MAX_LENGTH).default(""),
}).strict();

/** A mentor declares their own conflict; organisers record declared or affiliation conflicts for anyone. */
export async function setMentorConflict(actor: MentorContext | DeskOrganiserContext, input: unknown): Promise<DeskResult> {
  const parsed = conflictSchema.safeParse(input);
  if (!parsed.success) return fail(COPY.invalid);
  const data = parsed.data;
  if (actor.kind === "mentor" && (data.mentorUserId !== actor.userId || data.kind !== MentorConflictKind.DECLARED)) return fail(COPY.notFound);
  return inTransaction(async (tx) => {
    const event = await deskEvent(tx, actor, { allowDisabled: actor.kind === "organiser" });
    await liveMentor(tx, event.id, data.mentorUserId, { onShift: false });
    const team = await tx.team.findFirst({ where: { id: data.teamId, eventId: event.id }, select: { id: true } });
    if (!team) refuse(COPY.notFound);
    const existing = await tx.mentorConflict.findFirst({ where: { eventId: event.id, mentorUserId: data.mentorUserId, teamId: team.id, kind: data.kind, active: true } });
    if (existing) {
      await tx.mentorConflict.update({ where: { id: existing.id }, data: { active: data.active, reason: data.reason, version: { increment: 1 } } });
    } else if (data.active) {
      await tx.mentorConflict.create({ data: { eventId: event.id, mentorUserId: data.mentorUserId, teamId: team.id, kind: data.kind, reason: data.reason } });
    }
    await recordAuditEvent({ client: tx, action: data.active ? "MENTOR_CONFLICT_RECORDED" : "MENTOR_CONFLICT_CLEARED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: "Team", targetId: team.id, metadata: { kind: data.kind } });
    return undefined;
  });
}
