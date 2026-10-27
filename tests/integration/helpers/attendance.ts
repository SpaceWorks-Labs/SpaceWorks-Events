import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, MembershipRole, RegistrationMode, RsvpStatus, SoloPolicy, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ATTENDANCE_REMINDER_INTERVAL_MS } from "@/lib/attendanceCheck";
import { hashAttendanceToken } from "@/lib/attendanceToken";

/*
 * Shared fixtures for the attendance confirmation suites (docs/ATTENDANCE.md).
 * Each suite mocks `@/lib/auth`, `@/lib/actionRateLimit`, `next/cache` and the
 * attendance email itself, then calls setUpAttendance / tearDownAttendance.
 */

export const att = {
  suffix: randomUUID().replace(/-/g, ""),
  orgId: "",
  otherOrgId: "",
  ownerId: "",
  adminId: "",
  memberId: "",
  otherOwnerId: "",
  get orgSlug() { return `attend-${this.suffix}`; },
  get otherOrgSlug() { return `attend-other-${this.suffix}`; },
};
const userIds: string[] = [];
let sequence = 0;

export const FUTURE_START = new Date("2035-01-01T10:00:00.000Z");
const FUTURE_END = new Date("2035-01-01T12:00:00.000Z");

export async function makeUser(label: string, role?: MembershipRole, organisationId = att.orgId) {
  const user = await prisma.user.create({ data: { email: `attend-${label}-${att.suffix}@example.test`, name: `Attend ${label}`, emailVerified: new Date() } });
  userIds.push(user.id);
  if (role) await prisma.membership.create({ data: { userId: user.id, organisationId, role } });
  return user.id;
}

export async function setUpAttendance(name = "Attendance org") {
  att.orgId = (await prisma.organisation.create({ data: { name, slug: att.orgSlug } })).id;
  att.otherOrgId = (await prisma.organisation.create({ data: { name: "Attendance other", slug: att.otherOrgSlug } })).id;
  att.ownerId = await makeUser("owner", MembershipRole.OWNER);
  att.adminId = await makeUser("admin", MembershipRole.ADMIN);
  att.memberId = await makeUser("member", MembershipRole.MEMBER);
  att.otherOwnerId = await makeUser("other-owner", MembershipRole.OWNER, att.otherOrgId);
}

export async function tearDownAttendance() {
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' LIKE ${`%${att.suffix}@example.test`}`;
  await prisma.organisation.deleteMany({ where: { id: { in: [att.orgId, att.otherOrgId] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}

export type EventOptions = { organisationId?: string; start?: Date; status?: EventStatus; capacity?: number; releaseOnDecline?: boolean; registrationMode?: RegistrationMode; };

export async function makeEvent(options: EventOptions = {}) {
  sequence += 1;
  const team = options.registrationMode === RegistrationMode.TEAM;
  const start = options.start ?? FUTURE_START;
  return prisma.event.create({
    data: {
      organisationId: options.organisationId ?? att.orgId, title: `Attendance ${sequence}`, slug: `attendance-${sequence}-${att.suffix}`,
      startDateTime: start, endDateTime: new Date(Math.max(start.getTime() + 2 * 3_600_000, FUTURE_END.getTime())), timezone: "Europe/London",
      location: "Main hall", status: options.status ?? EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, capacity: options.capacity,
      attendanceCheckReleaseOnDecline: options.releaseOnDecline ?? false, registrationMode: options.registrationMode ?? RegistrationMode.INDIVIDUAL,
      teamMaxSize: team ? 4 : undefined, soloPolicy: SoloPolicy.SOLO_ALLOWED, page: { create: { isPublished: true } },
    },
  });
}

export async function guest(eventId: string, status: RsvpStatus = RsvpStatus.CONFIRMED, extra: { checkedInAt?: Date } = {}) {
  sequence += 1;
  const email = `guest-${sequence}-${att.suffix}@example.test`;
  return prisma.rSVP.create({ data: { eventId, attendeeKey: `guest:${email}`, guestEmail: email, guestName: `Guest ${sequence}`, status, ...extra } });
}

export const ref = (event: Pick<Event, "id" | "organisationId">) => ({
  organisationSlug: event.organisationId === att.otherOrgId ? att.otherOrgSlug : att.orgSlug,
  eventId: event.id,
});

/** The raw link token exists only in the queued email; take the current one for this registration. */
export async function tokenFor(rsvpId: string) {
  const check = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId }, select: { tokenHash: true } });
  const messages = await prisma.outboxMessage.findMany({ where: { kind: "attendance-check", payload: { path: ["rsvpId"], equals: rsvpId } } });
  const token = messages.map((message) => (message.payload as { token?: string }).token).find((raw) => raw && hashAttendanceToken(raw) === check.tokenHash);
  if (!token) throw new Error("no current attendance token queued");
  return token;
}

export async function queuedFor(eventId: string) {
  const rsvpIds = (await prisma.rSVP.findMany({ where: { eventId }, select: { id: true } })).map((row) => row.id);
  if (rsvpIds.length === 0) return [];
  return prisma.outboxMessage.findMany({ where: { kind: "attendance-check", OR: rsvpIds.map((id) => ({ payload: { path: ["rsvpId"], equals: id } })) } });
}

/** Move a check's last email back in time, as if the 12 hours had passed. */
export async function ageCheck(rsvpId: string, ms = ATTENDANCE_REMINDER_INTERVAL_MS + 60_000) {
  await prisma.attendanceCheck.update({ where: { rsvpId }, data: { sentAt: new Date(Date.now() - ms) } });
}

export const clearAttendanceQueue = () => prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "kind" = 'attendance-check' AND "payload"->>'to' LIKE ${`%${att.suffix}@example.test`}`;
