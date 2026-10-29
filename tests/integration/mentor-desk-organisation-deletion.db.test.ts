import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: identity.id }, authenticatedAt: Date.now() }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/payments/obligations", async (original) => {
  const actual = await original<typeof import("@/lib/payments/obligations")>();
  return { ...actual, organisationMoneyBlocker: vi.fn(actual.organisationMoneyBlocker) };
});
vi.mock("@/lib/storage/objects", async (original) => ({
  ...await original<typeof import("@/lib/storage/objects")>(),
  currentStorageLocation: () => "deletion-retry-test",
}));

import { prisma } from "@/lib/db";
import { deleteOrganisation } from "@/app/actions/membership";
import { resolveDeskOrganiser } from "@/lib/core/mentorDesk/access";
import { helpCommand } from "@/lib/core/mentorDesk/helpCommands";
import { organisationMoneyBlocker } from "@/lib/payments/obligations";
import { fulfilled, holdLocks, raceBehind } from "./helpers/locks";

const suffix = randomUUID();
const guestEmail = `guest-${suffix}@example.test`;
let organisationId = "";
const userIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { name: "Deletion retry", slug: `retry-${suffix}` } });
  organisationId = org.id;
  for (const name of ["owner", "mentor"]) {
    const user = await prisma.user.create({ data: { email: `${name}-${suffix}@example.test`, emailVerified: new Date() } });
    userIds.push(user.id);
  }
  identity.id = userIds[0]!;
  await prisma.membership.create({ data: { organisationId, userId: identity.id, role: "OWNER" } });
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.auditEvent.deleteMany({ where: { targetId: organisationId } });
  await prisma.storageDeletion.deleteMany({ where: { organisationId } });
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], equals: guestEmail } } });
  await prisma.auditEvent.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

// G1: Event -> audit's Organisation FK crosses deletion's Organisation -> Event cascade.
it("retries the whole organisation deletion after an organiser assign deadlocks, without duplicate side effects", async () => {
  const org = await prisma.organisation.findUniqueOrThrow({ where: { id: organisationId } });
  const startsAt = new Date(Date.now() - 3_600_000);
  const endsAt = new Date(Date.now() + 3_600_000);
  const event = await prisma.event.create({ data: {
    organisationId, title: "Mentor help", slug: `help-${suffix}`, status: "PUBLISHED", timezone: "UTC",
    startDateTime: startsAt, endDateTime: endsAt, mentorDeskEnabled: true,
  } });
  const mentorUserId = userIds[1]!;
  await prisma.eventCollaborator.create({ data: { eventId: event.id, userId: mentorUserId, permissions: ["MENTOR"] } });
  await prisma.mentorProfile.create({ data: {
    eventId: event.id, userId: mentorUserId,
    availability: [{ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }],
  } });
  const rsvp = await prisma.rSVP.create({ data: {
    eventId: event.id, guestEmail, guestName: "Guest", attendeeKey: `guest:${guestEmail}`, status: "CONFIRMED",
  } });
  const category = await prisma.helpCategory.create({ data: { eventId: event.id, key: "general", label: "General" } });
  const request = await prisma.helpRequest.create({ data: {
    eventId: event.id, categoryId: category.id, rsvpId: rsvp.id, origin: "TEAM", summary: "Help please",
    exclusiveUntil: startsAt, expiresAt: endsAt,
  } });
  const key = `organisations/${organisationId}/test.webp`;
  await prisma.asset.create({ data: { organisationId, key, provider: "s3" } });
  const organiser = await resolveDeskOrganiser(identity.id, org.slug, event.id);
  if (!organiser) throw new Error("Missing organiser");
  vi.mocked(organisationMoneyBlocker).mockClear();

  // Assign holds Event and the grant, then queues on HelpRequest. Deletion
  // holds Organisation and queues on Event. Releasing HelpRequest lets assign
  // reach its audit FK: deletion's wait began first, so it detects the cycle.
  const barrier = await holdLocks((tx) => tx.$queryRaw`SELECT "id" FROM "HelpRequest" WHERE "id" = ${request.id} FOR UPDATE`);
  const [assigning, deleting] = await raceBehind(barrier,
    () => helpCommand(organiser, { requestId: request.id, expectedVersion: request.version, action: "assign", mentorUserId }),
    () => deleteOrganisation({ organisationSlug: org.slug }),
  );
  expect(fulfilled(deleting)).toEqual({ ok: true });
  expect(await prisma.organisation.count({ where: { id: organisationId } })).toBe(0);
  expect(organisationMoneyBlocker).toHaveBeenCalledTimes(2);
  const assigned = fulfilled(assigning);
  if (!assigned.ok) expect(assigned.error).toEqual(expect.any(String));
  expect(await prisma.auditEvent.count({ where: { action: "MENTOR_HELP_ASSIGNED", targetId: request.id } })).toBe(assigned.ok ? 1 : 0);
  expect(await prisma.auditEvent.count({ where: { action: "ORGANISATION_DELETED", targetId: organisationId } })).toBe(1);
  expect(await prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: guestEmail } } })).toBe(1);
  expect(await prisma.storageDeletion.findMany({ where: { organisationId }, select: { kind: true, key: true }, orderBy: { kind: "asc" } })).toEqual([
    { kind: "OBJECT", key }, { kind: "PREFIX", key: `organisations/${organisationId}/` },
  ]);
});
