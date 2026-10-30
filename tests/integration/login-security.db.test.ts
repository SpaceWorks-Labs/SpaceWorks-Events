import { randomUUID } from "node:crypto";
import { MembershipRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; }; mfaVerified?: boolean; }, proof: undefined as string | undefined, token: undefined as string | undefined }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({
  get: () => (session.proof ? { value: session.proof } : undefined),
  getAll: () => (session.token ? [{ name: "swe.session-token.v1", value: session.token }] : []),
}) }));

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { verifyPasswordSignIn } from "@/lib/credentialsAuth";
import {
  accountUnderAttack, consumeSignInCode, deviceHash, isAddressBlocked, knownDevice, noteFailedSignIn, rememberSignIn, sendSignInCode,
} from "@/lib/loginSecurity";
import { encode } from "next-auth/jwt";
import { createMfaProof } from "@/lib/mfaProof";
import { getMembership } from "@/lib/permissions";
import { staffMfaState } from "@/lib/staffMfa";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const email = (name: string) => `${name}-${suffix}@example.test`;
const users: Record<string, string> = {};
let organisationId = "";

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-with-at-least-32-characters");
  for (const name of ["person", "member", "attendee"]) {
    users[name] = (await prisma.user.create({ data: { name, email: email(name), emailVerified: new Date() } })).id;
  }
  organisationId = (await prisma.organisation.create({ data: { name: "Secure Makers", slug: `secure-${suffix}` } })).id;
  await prisma.membership.create({ data: { userId: users.member!, organisationId, role: MembershipRole.ADMIN } });
});

beforeEach(() => {
  session.value = null;
  session.proof = undefined;
  session.token = undefined;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
});

describe("sign-in protections", () => {
  it("trusts the first device silently, then alerts on a new one", async () => {
    const first = deviceHash("a".repeat(64));
    expect(await knownDevice(users.person!, first)).toEqual({ known: false, firstDevice: true });
    await rememberSignIn({ userId: users.person!, email: email("person"), hash: first, ip: "203.0.113.5", userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0", firstDevice: true });
    expect(await knownDevice(users.person!, first)).toEqual({ known: true, firstDevice: false });
    const alerts = () => prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: email("person") } } });
    expect(await alerts()).toBe(0);

    const second = deviceHash("b".repeat(64));
    expect(await knownDevice(users.person!, second)).toEqual({ known: false, firstDevice: false });
    await rememberSignIn({ userId: users.person!, email: email("person"), hash: second, ip: "203.0.113.9", userAgent: "Mozilla/5.0 (iPhone) Safari/604.1", firstDevice: false });
    expect(await alerts()).toBe(1);
    const [device] = await prisma.userDevice.findMany({ where: { userId: users.person!, deviceHash: second! } });
    // Only a hash of the browser's id is kept.
    expect(device).toMatchObject({ userAgent: "Safari on iOS", lastIp: "203.0.113.9" });
    expect(device!.deviceHash).not.toContain("b".repeat(64));
  });

  it("audits and alerts a password sign-in that sends no usable device id", async () => {
    await prisma.user.update({ where: { id: users.attendee! }, data: { passwordHash: await bcrypt.hash("correct horse battery", 4) } });
    await rememberSignIn({ userId: users.attendee!, email: email("attendee"), hash: deviceHash("c".repeat(64)), ip: "203.0.113.5", userAgent: "Chrome/130.0", firstDevice: true });
    const audits = () => prisma.auditEvent.count({ where: { action: "SIGN_IN_NEW_DEVICE", actorUserId: users.attendee! } });
    const alerts = () => prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: email("attendee") } } });
    expect([await audits(), await alerts()]).toEqual([1, 0]);

    const context = { ip: "198.51.100.20", userAgent: "curl/8.0" };
    const withoutDevice = await verifyPasswordSignIn({ email: email("attendee"), password: "correct horse battery" }, context);
    expect(withoutDevice.ok).toBe(true);
    expect([await audits(), await alerts()]).toEqual([2, 1]);
    // A malformed id is no better than none, and neither is remembered.
    const malformed = await verifyPasswordSignIn({ email: email("attendee"), password: "correct horse battery", device: "not-a-device-id" }, context);
    expect(malformed.ok).toBe(true);
    expect([await audits(), await alerts()]).toEqual([3, 2]);
    expect(await prisma.userDevice.count({ where: { userId: users.attendee! } })).toBe(1);
    await prisma.userDevice.deleteMany({ where: { userId: users.attendee! } });
    await prisma.user.update({ where: { id: users.attendee! }, data: { passwordHash: null } });
  });

  it("emails a code that works once, and never stores the code itself", async () => {
    expect(await sendSignInCode({ id: users.person!, email: email("person") })).toBe(true);
    const message = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "sign-in-code", payload: { path: ["to"], equals: email("person") } }, orderBy: { createdAt: "desc" } });
    const code = (message.payload as { code: string; }).code;
    const token = await prisma.verificationToken.findFirstOrThrow({ where: { identifier: `sign-in:${users.person}` } });
    expect(token.token).not.toContain(code);
    expect(await consumeSignInCode(users.person!, code === "000000" ? "000001" : "000000")).toBe(false);
    expect(await consumeSignInCode(users.person!, code)).toBe(true);
    expect(await consumeSignInCode(users.person!, code)).toBe(false);
  });

  it("alerts on every missing or malformed device sign-in even before any device is remembered", async () => {
    const userId = users.attendee!;
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash("correct horse battery", 4) } });
    await prisma.userDevice.deleteMany({ where: { userId } });
    const alerts = () => prisma.outboxMessage.count({ where: { kind: "operator-notice", payload: { path: ["to"], equals: email("attendee") } } });
    const before = await alerts();
    for (const [index, device] of [undefined, undefined, "not-a-device-id"].entries()) {
      expect(await knownDevice(userId, deviceHash(device))).toEqual({ known: false, firstDevice: true });
      const result = await verifyPasswordSignIn({ email: email("attendee"), password: "correct horse battery", device }, { ip: "198.51.100.21", userAgent: "curl/8.0" });
      expect(result.ok).toBe(true);
      expect(await alerts()).toBe(before + index + 1);
      expect(await prisma.userDevice.count({ where: { userId } })).toBe(0);
    }
    await rememberSignIn({ userId, email: email("attendee"), hash: "invalid-hash", ip: "unknown", userAgent: "curl/8.0", firstDevice: true });
    expect(await alerts()).toBe(before + 4);
    expect(await prisma.userDevice.count({ where: { userId } })).toBe(0);
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: null } });
  });

  it("counts failures per account and per address, and never blocks an unknown address", async () => {
    const victim = email("victim");
    for (let attempt = 0; attempt < 5; attempt += 1) await noteFailedSignIn("198.51.100.77", victim);
    expect(await accountUnderAttack(victim)).toBe(true);
    expect(await accountUnderAttack(email("someone-else"))).toBe(false);
    for (let attempt = 0; attempt < 15; attempt += 1) await noteFailedSignIn("198.51.100.77", email(`spray-${attempt}`));
    expect(await isAddressBlocked("198.51.100.77")).toBe(true);
    expect(await isAddressBlocked("198.51.100.78")).toBe(false);
    for (let attempt = 0; attempt < 25; attempt += 1) await noteFailedSignIn("unknown", email(`unknown-${attempt}`));
    expect(await isAddressBlocked("unknown")).toBe(false);
  });
});

describe("staff authenticator rule", () => {
  beforeAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "true"));
  afterAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "false"));

  it("holds a member's staff powers until they set up and confirm an authenticator", async () => {
    session.value = { user: { id: users.member! } };
    expect(await staffMfaState(users.member!)).toBe("enrol");
    expect(await getMembership(users.member!, organisationId)).toBeNull();

    await prisma.user.update({ where: { id: users.member! }, data: { mfaEnabledAt: new Date() } });
    session.value = { user: { id: users.member! } };
    expect(await staffMfaState(users.member!)).toBe("verify");

    session.value = { user: { id: users.member! }, mfaVerified: true };
    expect(await getMembership(users.member!, organisationId)).toMatchObject({ role: "ADMIN" });

    // A Google sign-in confirms with a code afterwards: the proof cookie,
    // bound to this browser's sign-in id inside the session cookie.
    const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: users.member! }, select: { sessionVersion: true } });
    const sessionCookie = (sid: string) => encode({ token: { sub: users.member!, sid }, secret: "integration-auth-secret-with-at-least-32-characters", salt: "swe.session-token.v1" });
    session.value = { user: { id: users.member! } };
    session.token = await sessionCookie("sign-in-a");
    session.proof = createMfaProof(users.member!, sessionVersion, "sign-in-a");
    expect(await staffMfaState(users.member!)).toBe("ok");
    expect(await getMembership(users.member!, organisationId)).toMatchObject({ role: "ADMIN" });

    // A new sign-in in the same browser leaves the old proof behind.
    session.token = await sessionCookie("sign-in-b");
    expect(await staffMfaState(users.member!)).toBe("verify");
    expect(await getMembership(users.member!, organisationId)).toBeNull();
    // So does a session cookie without a sign-in id (or none at all).
    session.token = await encode({ token: { sub: users.member! }, secret: "integration-auth-secret-with-at-least-32-characters", salt: "swe.session-token.v1" });
    expect(await staffMfaState(users.member!)).toBe("verify");
  });

  it("leaves attendees, other people's checks and the super admin alone", async () => {
    session.value = { user: { id: users.attendee! } };
    expect(await staffMfaState(users.attendee!)).toBe("ok");
    // Checking someone else's membership (removing a member) is never affected.
    expect(await getMembership(users.member!, organisationId)).toMatchObject({ role: "ADMIN" });

    vi.stubEnv("SUPER_ADMIN_EMAIL", email("member"));
    await prisma.user.update({ where: { id: users.member! }, data: { mfaEnabledAt: null } });
    session.value = { user: { id: users.member! } };
    expect(await staffMfaState(users.member!)).toBe("ok");
    vi.stubEnv("SUPER_ADMIN_EMAIL", "");
  });
});
