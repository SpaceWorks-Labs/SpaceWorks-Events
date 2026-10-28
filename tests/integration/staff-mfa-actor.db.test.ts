import { randomUUID } from "node:crypto";
import { EventPermission, MembershipRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; }; mfaVerified?: boolean; } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { prisma } from "@/lib/db";
import { canAccessEvent, canViewEventDashboard } from "@/lib/eventAccess";
import { getMembership } from "@/lib/permissions";
import { runAsRequestActor, type MobileRequestActor } from "@/lib/requestActor";
import { staffMfaState } from "@/lib/staffMfa";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const email = (name: string) => `${name}-${suffix}@example.test`;
const users: Record<string, string> = {};
let organisationId = "";
let eventId = "";

function actor(userId: string, mfaVerifiedAt: Date | null): MobileRequestActor {
  return { kind: "mobile", userId, sessionId: `session-${suffix}`, mfaVerifiedAt, authenticatedAt: new Date() };
}

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-with-at-least-32-characters");
  vi.stubEnv("STAFF_MFA_REQUIRED", "true");
  for (const name of ["admin", "helper", "attendee"]) {
    users[name] = (await prisma.user.create({ data: { name, email: email(name), emailVerified: new Date(), mfaEnabledAt: new Date() } })).id;
  }
  organisationId = (await prisma.organisation.create({ data: { name: "Actor Makers", slug: `actor-${suffix}` } })).id;
  await prisma.membership.create({ data: { userId: users.admin!, organisationId, role: MembershipRole.ADMIN } });
  eventId = (await prisma.event.create({
    data: { organisationId, title: "Actor night", slug: `actor-night-${suffix}`, startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000), timezone: "UTC" },
  })).id;
  await prisma.eventCollaborator.create({ data: { userId: users.helper!, eventId, permissions: [EventPermission.CHECK_IN] } });
});

beforeEach(() => {
  session.value = null;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
});

describe("staff authenticator rule for app sessions", () => {
  it("gives a mobile staff session without a recent check no staff access", async () => {
    await runAsRequestActor(actor(users.admin!, null), async () => {
      expect(await staffMfaState(users.admin!)).toBe("verify");
      expect(await getMembership(users.admin!, organisationId)).toBeNull();
      expect(await canViewEventDashboard({ userId: users.admin!, organisationId, eventId })).toBe(false);
    });
    await runAsRequestActor(actor(users.helper!, new Date(Date.now() - 13 * 60 * 60 * 1000)), async () => {
      expect(await staffMfaState(users.helper!)).toBe("verify");
      expect(await canAccessEvent({ userId: users.helper!, organisationId, eventId, permission: EventPermission.CHECK_IN })).toBe(false);
    });
  });

  it("asks a mobile staff member without an authenticator to set one up", async () => {
    await prisma.user.update({ where: { id: users.helper! }, data: { mfaEnabledAt: null } });
    await runAsRequestActor(actor(users.helper!, new Date()), async () => {
      expect(await staffMfaState(users.helper!)).toBe("enrol");
    });
    await prisma.user.update({ where: { id: users.helper! }, data: { mfaEnabledAt: new Date() } });
  });

  it("opens staff access after a recent check on the app session", async () => {
    await runAsRequestActor(actor(users.admin!, new Date()), async () => {
      expect(await getMembership(users.admin!, organisationId)).toMatchObject({ role: "ADMIN" });
      expect(await canViewEventDashboard({ userId: users.admin!, organisationId, eventId })).toBe(true);
    });
    await runAsRequestActor(actor(users.helper!, new Date()), async () => {
      expect(await canAccessEvent({ userId: users.helper!, organisationId, eventId, permission: EventPermission.CHECK_IN })).toBe(true);
    });
  });

  it("ignores a verified cookie session while a mobile actor is set", async () => {
    session.value = { user: { id: users.admin! }, mfaVerified: true };
    await runAsRequestActor(actor(users.admin!, null), async () => {
      expect(await getMembership(users.admin!, organisationId)).toBeNull();
    });
  });

  it("leaves attendees and checks about other people alone", async () => {
    await runAsRequestActor(actor(users.attendee!, null), async () => {
      expect(await staffMfaState(users.attendee!)).toBe("ok");
      expect(await getMembership(users.admin!, organisationId)).toMatchObject({ role: "ADMIN" });
    });
  });

  it("fails closed for a staff check with neither an actor nor a cookie session", async () => {
    expect(await staffMfaState(users.admin!)).toBe("verify");
    expect(await getMembership(users.admin!, organisationId)).toBeNull();
    expect(await staffMfaState(users.attendee!)).toBe("ok");
  });

  it("keeps cookie-session behaviour unchanged", async () => {
    session.value = { user: { id: users.admin! } };
    expect(await staffMfaState(users.admin!)).toBe("verify");
    session.value = { user: { id: users.admin! }, mfaVerified: true };
    expect(await getMembership(users.admin!, organisationId)).toMatchObject({ role: "ADMIN" });
    session.value = { user: { id: users.attendee! } };
    expect(await getMembership(users.admin!, organisationId)).toMatchObject({ role: "ADMIN" });
  });
});
