import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { deviceHash } from "@/lib/loginSecurity";
import {
  issueMobileSession, markMobileSessionMfaVerified, refreshMobileSession, requireMobileUser, revokeMobileSession, revokeUserMobileSessions,
} from "@/lib/mobileAuth";
import { purgeExpiredOperationalData } from "@/lib/retention";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const device = deviceHash("c".repeat(64))!;
const otherDevice = deviceHash("d".repeat(64))!;
let userId = "";

const bearer = (token: string) => new Request("https://api.example.test/api/mobile/v1/me", { headers: { authorization: `Bearer ${token}` } });

async function signIn(mfaVerified = false) {
  const { sessionVersion } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
  const issued = await issueMobileSession({ userId, verifiedSessionVersion: sessionVersion, deviceHash: device, platform: "android", method: "password", mfaVerified });
  if (!issued) throw new Error("not issued");
  return issued;
}

beforeAll(async () => {
  userId = (await prisma.user.create({ data: { name: "Phone person", email: `phone-${suffix}@example.test`, emailVerified: new Date() } })).id;
});

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { actorUserId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("mobile sessions", () => {
  it("stores only token digests and authenticates the access token", async () => {
    const issued = await signIn();
    const row = await prisma.mobileSession.findUniqueOrThrow({ where: { id: issued.sessionId } });
    expect(JSON.stringify(row)).not.toContain(issued.accessToken);
    expect(JSON.stringify(row)).not.toContain(issued.refreshToken);
    expect(row.mfaVerifiedAt).toBeNull();
    const actor = await requireMobileUser(bearer(issued.accessToken));
    expect(actor).toMatchObject({ kind: "mobile", userId, sessionId: issued.sessionId, mfaVerifiedAt: null });
    expect(await requireMobileUser(bearer(issued.refreshToken))).toBeNull();
  });

  it("records an authenticator check on the session", async () => {
    const issued = await signIn();
    const actor = (await requireMobileUser(bearer(issued.accessToken)))!;
    await markMobileSessionMfaVerified(actor);
    expect((await requireMobileUser(bearer(issued.accessToken)))!.mfaVerifiedAt).toBeInstanceOf(Date);
  });

  it("rotates refresh tokens, refuses a quick retry without revoking, and revokes on later reuse", async () => {
    const issued = await signIn();
    const first = await refreshMobileSession(issued.refreshToken, device);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await requireMobileUser(bearer(issued.accessToken))).toBeNull();
    expect(await requireMobileUser(bearer(first.session.accessToken))).not.toBeNull();

    // A retry inside the grace window (lost response) is refused, session kept.
    expect(await refreshMobileSession(issued.refreshToken, device)).toEqual({ ok: false, reason: "invalid" });
    expect(await requireMobileUser(bearer(first.session.accessToken))).not.toBeNull();

    // After the window, a replay of the old token is theft: the session ends.
    await prisma.mobileSession.update({ where: { id: issued.sessionId }, data: { rotatedAt: new Date(Date.now() - 60_000) } });
    expect(await refreshMobileSession(issued.refreshToken, device)).toEqual({ ok: false, reason: "reused" });
    expect(await requireMobileUser(bearer(first.session.accessToken))).toBeNull();
    expect(await prisma.auditEvent.count({ where: { action: "MOBILE_REFRESH_TOKEN_REUSED", targetId: issued.sessionId } })).toBe(1);
  });

  it("binds refresh to the install that signed in", async () => {
    const issued = await signIn();
    expect(await refreshMobileSession(issued.refreshToken, null)).toEqual({ ok: false, reason: "invalid" });
    expect(await refreshMobileSession(issued.refreshToken, otherDevice)).toEqual({ ok: false, reason: "reused" });
    expect(await refreshMobileSession(issued.refreshToken, device)).toEqual({ ok: false, reason: "invalid" });
  });

  it("is refused by a session version bump, and by its own sign-out", async () => {
    const stale = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { sessionVersion: true } });
    const issued = await signIn();
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
      await revokeUserMobileSessions(tx, userId);
    });
    expect(await requireMobileUser(bearer(issued.accessToken))).toBeNull();
    expect((await refreshMobileSession(issued.refreshToken, device)).ok).toBe(false);
    expect(await issueMobileSession({ userId, verifiedSessionVersion: stale.sessionVersion, deviceHash: device, method: "password", mfaVerified: false })).toBeNull();

    const fresh = await signIn();
    await revokeMobileSession({ userId, sessionId: fresh.sessionId });
    expect(await requireMobileUser(bearer(fresh.accessToken))).toBeNull();
  });

  it("purges sessions past their lifetime", async () => {
    const issued = await signIn();
    await prisma.mobileSession.update({ where: { id: issued.sessionId }, data: { refreshExpiresAt: new Date(Date.now() - 1000) } });
    await purgeExpiredOperationalData();
    expect(await prisma.mobileSession.findUnique({ where: { id: issued.sessionId } })).toBeNull();
  });
});
