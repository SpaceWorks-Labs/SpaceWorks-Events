"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/permissions";
import { hasRecentAuthentication } from "@/lib/reauth";
import { consumeMfaCode, createMfaEnrollment, decryptMfaSecret, encryptMfaSecret, generateRecoveryCodes, hashRecoveryCode, verifyMfaCode } from "@/lib/mfa";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import type { ActionResult } from "./org";
import { revokeUserMobileSessions } from "@/lib/mobileAuth";

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });

export async function beginMfaEnrollment(): Promise<ActionResult<{ secret: string; uri: string }>> {
  const session = await requireAuth();
  if (!(await hasRecentAuthentication())) return { ok: false, error: "Sign in again before enabling MFA." };
  if (!session.user.email) return { ok: false, error: "An email address is required to enable MFA." };
  if (await isActionRateLimited("auth", session.user.id)) return { ok: false, error: "Too many attempts. Please try again later." };
  const current = await prisma.user.findUnique({ where: { id: session.user.id }, select: { mfaSecretEncrypted: true, sessionVersion: true } });
  if (!current || current.mfaSecretEncrypted) return { ok: false, error: "Disable existing MFA before starting a new setup." };
  const enrollment = createMfaEnrollment(session.user.email);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.user.id} FOR UPDATE`;
    await tx.verificationToken.deleteMany({ where: { identifier: `mfa:${session.user.id}` } });
    await tx.verificationToken.create({
      data: {
        identifier: `mfa:${session.user.id}`,
        token: encryptMfaSecret(JSON.stringify({ secret: enrollment.secret, sessionVersion: current.sessionVersion })),
        expires: new Date(Date.now() + 10 * 60_000),
      },
    });
  });
  return { ok: true, data: enrollment };
}

export async function confirmMfaEnrollment(input: unknown): Promise<ActionResult<{ recoveryCodes: string[] }>> {
  const session = await requireAuth();
  if (await isActionRateLimited("auth", session.user.id)) {
    return { ok: false, error: "Too many attempts. Please try again later." };
  }
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success || !session.user.email) return { ok: false, error: "Enter a valid authenticator code." };
  if (!(await hasRecentAuthentication())) return { ok: false, error: "Sign in again before enabling MFA." };
  const pending = await prisma.verificationToken.findFirst({
    where: { identifier: `mfa:${session.user.id}`, expires: { gt: new Date() } },
    orderBy: { expires: "desc" },
  });
  if (!pending) return { ok: false, error: "MFA setup expired. Start again." };
  let setup: { secret: string; sessionVersion: number };
  try {
    setup = JSON.parse(decryptMfaSecret(pending.token));
    if (typeof setup.secret !== "string" || !Number.isSafeInteger(setup.sessionVersion)) throw new Error("Invalid setup");
  } catch { return { ok: false, error: "MFA setup expired. Start again." }; }
  const { secret } = setup;
  if (!verifyMfaCode(secret, session.user.email, parsed.data.code)) return { ok: false, error: "Invalid authenticator code." };
  const recoveryCodes = generateRecoveryCodes();
  const enabled = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.user.id} FOR UPDATE`;
    const consumed = await tx.verificationToken.deleteMany({ where: { identifier: `mfa:${session.user.id}`, token: pending.token, expires: { gt: new Date() } } });
    if (consumed.count !== 1) return false;
    const updated = await tx.user.updateMany({
      where: { id: session.user.id, mfaSecretEncrypted: null, sessionVersion: setup.sessionVersion },
      data: {
        mfaSecretEncrypted: encryptMfaSecret(secret),
        mfaEnabledAt: new Date(),
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
        sessionVersion: { increment: 1 },
      },
    });
    if (updated.count !== 1) return false;
    await tx.verificationToken.deleteMany({ where: { identifier: `mfa:${session.user.id}` } });
    await revokeUserMobileSessions(tx, session.user.id);
    await tx.auditEvent.create({ data: { action: "MFA_ENABLED", actorUserId: session.user.id, targetType: "User", targetId: session.user.id } });
    return true;
  });
  if (!enabled) return { ok: false, error: "MFA setup changed or expired. Start again." };
  return { ok: true, data: { recoveryCodes } };
}

export async function disableMfa(input: unknown): Promise<ActionResult> {
  const session = await requireAuth();
  if (await isActionRateLimited("auth", session.user.id)) {
    return { ok: false, error: "Too many attempts. Please try again later." };
  }
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success || !session.user.email) return { ok: false, error: "Enter an authenticator or recovery code." };
  if (!(await hasRecentAuthentication())) return { ok: false, error: "Sign in again before disabling MFA." };
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { mfaSecretEncrypted: true, recoveryCodeHashes: true, sessionVersion: true } });
  if (!user?.mfaSecretEncrypted) return { ok: false, error: "MFA is not enabled." };
  const validTotp = await consumeMfaCode(decryptMfaSecret(user.mfaSecretEncrypted), session.user.email, parsed.data.code);
  const validRecovery = user.recoveryCodeHashes.includes(hashRecoveryCode(parsed.data.code));
  if (!validTotp && !validRecovery) return { ok: false, error: "Invalid authenticator or recovery code." };
  const disabled = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.user.id} FOR UPDATE`;
    const updated = await tx.user.updateMany({ where: { id: session.user.id, mfaSecretEncrypted: user.mfaSecretEncrypted, sessionVersion: user.sessionVersion, ...(!validTotp ? { recoveryCodeHashes: { has: hashRecoveryCode(parsed.data.code) } } : {}) }, data: { mfaSecretEncrypted: null, mfaEnabledAt: null, recoveryCodeHashes: [], sessionVersion: { increment: 1 } } });
    if (updated.count !== 1) return false;
    await tx.verificationToken.deleteMany({ where: { identifier: `mfa:${session.user.id}` } });
    await revokeUserMobileSessions(tx, session.user.id);
    await tx.auditEvent.create({ data: { action: "MFA_DISABLED", actorUserId: session.user.id, targetType: "User", targetId: session.user.id } });
    return true;
  });
  if (!disabled) return { ok: false, error: "Account security changed. Sign in again and retry." };
  return { ok: true };
}

export async function revokeAllSessions(): Promise<ActionResult> {
  const session = await requireAuth();
  if (!(await hasRecentAuthentication())) return { ok: false, error: "Sign in again before revoking sessions." };
  if (await isActionRateLimited("auth", session.user.id)) return { ok: false, error: "Too many attempts. Please try again later." };
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${session.user.id} FOR UPDATE`;
    await tx.user.update({ where: { id: session.user.id }, data: { sessionVersion: { increment: 1 } } });
    await tx.verificationToken.deleteMany({ where: { identifier: `mfa:${session.user.id}` } });
    await tx.session.deleteMany({ where: { userId: session.user.id } });
    await revokeUserMobileSessions(tx, session.user.id);
    await tx.auditEvent.create({ data: { action: "SESSIONS_REVOKED", actorUserId: session.user.id, targetType: "User", targetId: session.user.id } });
  });
  return { ok: true };
}
