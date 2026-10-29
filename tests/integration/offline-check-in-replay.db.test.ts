import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, MembershipRole, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Offline check-in replay protection: a desk's queued check-in is claimed by
 * its clientMutationId with its outcome, so a retry (for example after a lost
 * response) never checks a guest in again once an organiser has undone it.
 */
const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { syncOfflineCheckIns, undoCheckIn } from "@/app/actions/checkin";
import { commitCheckInProjection } from "@/lib/checkInMutations";
import { purgeExpiredOperationalData } from "@/lib/retention";

const suffix = randomUUID().replaceAll("-", "");
const orgSlug = `offline-replay-${suffix}`;
let organisationId = "";
let eventId = "";
let userId = "";

async function guest(label: string, status: RsvpStatus = RsvpStatus.CONFIRMED) {
  const email = `${label}-${suffix}@example.test`;
  return prisma.rSVP.create({ data: { eventId, attendeeKey: `guest:${email}`, guestEmail: email, guestName: label, status } });
}
const sync = (checkIns: Array<{ rsvpId: string; clientMutationId: string; checkedInAt: string; force?: boolean }>) =>
  syncOfflineCheckIns({ organisationSlug: orgSlug, eventId, checkIns });
const undo = (rsvpId: string) => undoCheckIn({ organisationSlug: orgSlug, eventId, rsvpId });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const checkedIn = async (rsvpId: string) => (await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvpId } })).checkedInAt;

beforeAll(async () => {
  organisationId = (await prisma.organisation.create({ data: { name: "Offline replay", slug: orgSlug } })).id;
  userId = (await prisma.user.create({ data: { email: `offline-owner-${suffix}@example.test`, emailVerified: new Date() } })).id;
  await prisma.membership.create({ data: { userId, organisationId, role: MembershipRole.OWNER } });
  eventId = (await prisma.event.create({ data: {
    organisationId,
    title: "Offline replay",
    slug: `offline-replay-${suffix}`,
    // A long event, so the 7-day bound is reachable inside its operating window.
    startDateTime: new Date(Date.now() - 9 * 24 * 60 * 60_000),
    endDateTime: new Date(Date.now() + 2 * 60 * 60_000),
    timezone: "UTC",
    status: EventStatus.PUBLISHED,
    privacyType: EventPrivacyType.PUBLIC,
  } })).id;
  session.userId = userId;
});

afterAll(async () => {
  session.userId = null;
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe.sequential("offline check-in replay", () => {
  it("returns the stored outcome for a retried check-in, and never checks in again after an undo", async () => {
    const rsvp = await guest("retry");
    const entry = { rsvpId: rsvp.id, clientMutationId: `mutation-a-${suffix}`, checkedInAt: minutesAgo(10) };
    expect(await sync([entry])).toMatchObject({ ok: true, data: { syncedIds: [rsvp.id] } });
    expect(await undo(rsvp.id)).toMatchObject({ ok: true });
    // The response was lost, so the device sends the same queue entry again.
    expect(await sync([entry])).toMatchObject({ ok: true, data: { syncedIds: [rsvp.id], failed: [] } });
    expect(await checkedIn(rsvp.id)).toBeNull();
    await expect(prisma.checkInEvent.count({ where: { rsvpId: rsvp.id, action: "CHECKED_IN" } })).resolves.toBe(1);
  });

  it("records an already-checked-in outcome, so an undo is not reversed by the replay", async () => {
    const rsvp = await guest("existing");
    await commitCheckInProjection({ rsvpId: rsvp.id, actorUserId: null, source: "online", checkedInAt: new Date(minutesAgo(30)), force: false });
    const entry = { rsvpId: rsvp.id, clientMutationId: `mutation-b-${suffix}`, checkedInAt: minutesAgo(20) };
    expect(await sync([entry])).toMatchObject({ ok: true, data: { alreadyCheckedInIds: [rsvp.id] } });
    expect(await undo(rsvp.id)).toMatchObject({ ok: true });
    expect(await sync([entry])).toMatchObject({ ok: true, data: { syncedIds: [], alreadyCheckedInIds: [rsvp.id] } });
    expect(await checkedIn(rsvp.id)).toBeNull();
    const stored = await prisma.offlineCheckInMutation.findUniqueOrThrow({ where: { eventId_clientMutationId: { eventId, clientMutationId: entry.clientMutationId } } });
    expect(stored.outcome).toMatchObject({ state: "already-checked-in" });
  });

  it("records a status refusal, which a later replay repeats", async () => {
    const rsvp = await guest("declined", RsvpStatus.REJECTED);
    const entry = { rsvpId: rsvp.id, clientMutationId: `mutation-c-${suffix}`, checkedInAt: minutesAgo(5) };
    const first = await sync([entry]);
    expect(first).toMatchObject({ ok: true, data: { syncedIds: [], failed: [{ rsvpId: rsvp.id }] } });
    await prisma.rSVP.update({ where: { id: rsvp.id }, data: { status: RsvpStatus.CONFIRMED } });
    expect(await sync([entry])).toEqual(first);
    expect(await checkedIn(rsvp.id)).toBeNull();
  });

  it("keeps the override gate: a forced offline check-in never admits a pending approval", async () => {
    const rsvp = await guest("approval", RsvpStatus.PENDING_APPROVAL);
    const result = await sync([{ rsvpId: rsvp.id, clientMutationId: `mutation-d-${suffix}`, checkedInAt: minutesAgo(5), force: true }]);
    expect(result).toMatchObject({ ok: true, data: { failed: [{ rsvpId: rsvp.id, error: "Registration is pending approval and cannot be checked in." }] } });
    expect(await checkedIn(rsvp.id)).toBeNull();
  });

  it("refuses the same mutation id with another registration, time or override", async () => {
    const [first, other] = await Promise.all([guest("mismatch-1"), guest("mismatch-2")]);
    const entry = { rsvpId: first.id, clientMutationId: `mutation-e-${suffix}`, checkedInAt: minutesAgo(15) };
    expect(await sync([entry])).toMatchObject({ ok: true, data: { syncedIds: [first.id] } });
    for (const changed of [{ ...entry, rsvpId: other.id }, { ...entry, checkedInAt: minutesAgo(14) }, { ...entry, force: true }]) {
      const result = await sync([changed]);
      expect(result).toMatchObject({ ok: true, data: { syncedIds: [], failed: [{ error: "This offline check-in was already sent with different details." }] } });
    }
    expect(await checkedIn(other.id)).toBeNull();
  });

  it("claims a mutation once when the same retry arrives twice at the same time", async () => {
    const rsvp = await guest("concurrent");
    const entry = { rsvpId: rsvp.id, clientMutationId: `mutation-f-${suffix}`, checkedInAt: minutesAgo(3) };
    const results = await Promise.all([sync([entry]), sync([entry])]);
    for (const result of results) expect(result).toMatchObject({ ok: true, data: { syncedIds: [rsvp.id] } });
    await expect(prisma.checkInEvent.count({ where: { rsvpId: rsvp.id, action: "CHECKED_IN" } })).resolves.toBe(1);
    await expect(prisma.offlineCheckInMutation.count({ where: { eventId, clientMutationId: entry.clientMutationId } })).resolves.toBe(1);
  });

  it("refuses check-ins older than 7 days and keeps records 8 days", async () => {
    const rsvp = await guest("old");
    const result = await sync([{ rsvpId: rsvp.id, clientMutationId: `mutation-g-${suffix}`, checkedInAt: minutesAgo(7 * 24 * 60 + 5) }]);
    expect(result).toMatchObject({ ok: true, data: { failed: [{ rsvpId: rsvp.id, error: "Offline check-ins older than 7 days are no longer accepted." }] } });
    expect(await checkedIn(rsvp.id)).toBeNull();
    await expect(prisma.offlineCheckInMutation.count({ where: { eventId, clientMutationId: `mutation-g-${suffix}` } })).resolves.toBe(0);

    const kept = await guest("kept");
    const entry = { rsvpId: kept.id, clientMutationId: `mutation-h-${suffix}`, checkedInAt: minutesAgo(6 * 24 * 60) };
    expect(await sync([entry])).toMatchObject({ ok: true, data: { syncedIds: [kept.id] } });
    const key = { eventId_clientMutationId: { eventId, clientMutationId: entry.clientMutationId } };
    await purgeExpiredOperationalData(new Date(Date.now() + 1.5 * 24 * 60 * 60_000));
    expect(await prisma.offlineCheckInMutation.findUnique({ where: key })).not.toBeNull();
    await purgeExpiredOperationalData(new Date(Date.now() + 2.5 * 24 * 60 * 60_000));
    expect(await prisma.offlineCheckInMutation.findUnique({ where: key })).toBeNull();
  });
});
