"use server";

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { newPasswordSchema } from "@/lib/passwordPolicy";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { isSuperAdminEmail } from "@/lib/superAdminEmail";
import { BREACHED_PASSWORD_MESSAGE, isBreachedPassword } from "@/lib/pwnedPasswords";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { enqueuePasswordReset } from "@/lib/outbox";
import { noticeEach } from "@/lib/notices";
import { revokeUserMobileSessions } from "@/lib/mobileAuth";

const TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// ── Request password reset ──────────────────────────────────────────

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
});

/**
 * Create a password reset token and (optionally) email a link.
 * Returns success even if the email isn't registered (prevents enumeration).
 */
export async function requestPasswordReset(
  input: unknown,
): Promise<ActionResult<{ sent: true }>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid email address.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { email } = parsed.data;
  if (await isActionRateLimited("passwordReset", email)) {
    // Keep this indistinguishable from the usual non-enumerating response.
    return { ok: true, data: { sent: true } };
  }
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true },
  });

  // Always return success to prevent email enumeration. The super admin's
  // password is reset only from the server, so no link is ever emailed for it.
  if (!user || !user.passwordHash || isSuperAdminEmail(email)) {
    return { ok: true, data: { sent: true } };
  }

  // Generate a secure random token
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expires = new Date(Date.now() + TOKEN_EXPIRY_MS);

  const baseUrl = (
    process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000"
  ).replace(/\/$/, "");
  const resetUrl = `${baseUrl}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

  // Persist the one-time hash and its expiring mail in one transaction. The
  // request path must never wait for SMTP or commit a token without delivery.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "email" = ${email} FOR UPDATE`;
    await tx.verificationToken.deleteMany({
      where: { identifier: `reset:${email}` },
    });
    await tx.verificationToken.create({
      data: { identifier: `reset:${email}`, token: tokenHash, expires },
    });
    await enqueuePasswordReset(tx, {
      to: email,
      resetUrl,
      expiresAt: expires.toISOString(),
    });
  });

  return { ok: true, data: { sent: true } };
}

// ── Confirm password reset ──────────────────────────────────────────

const resetSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  token: z.string().regex(/^[a-f0-9]{64}$/, "Invalid reset token."),
  password: newPasswordSchema,
});

/**
 * Verify the reset token and set a new password.
 */
export async function confirmPasswordReset(
  input: unknown,
): Promise<ActionResult<{ reset: true }>> {
  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { email, token, password } = parsed.data;
  if (await isActionRateLimited("passwordReset", email)) {
    return { ok: false, error: "Invalid or expired reset link." };
  }
  const tokenHash = hashToken(token);

  if (await isBreachedPassword(password)) return { ok: false, error: BREACHED_PASSWORD_MESSAGE, fieldErrors: { password: [BREACHED_PASSWORD_MESSAGE] } };
  const passwordHash = await bcrypt.hash(password, 12);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "email" = ${email} FOR UPDATE`;
    // Consume the exact token before changing credentials. This makes a reset
    // link single-use even if two requests arrive at the same time.
    const consumed = await tx.verificationToken.deleteMany({
      where: {
        identifier: `reset:${email}`,
        token: tokenHash,
        expires: { gt: new Date() },
      },
    });
    if (consumed.count !== 1) return false;
    const user = await tx.user.update({
      where: { email },
      data: { passwordHash, emailVerified: new Date(), sessionVersion: { increment: 1 } },
      select: { id: true },
    });
    await tx.session.deleteMany({ where: { userId: user.id } });
    await revokeUserMobileSessions(tx, user.id);
    await tx.verificationToken.deleteMany({ where: { identifier: { in: [`mfa:${user.id}`, `email-verification:${user.id}`] } } });
    await tx.auditEvent.create({ data: { action: "ACCOUNT_PASSWORD_RESET", actorUserId: user.id, targetType: "User", targetId: user.id } });
    await noticeEach(tx, [email], { subject: "Your password was changed", lines: ["The password for your Space Works Events account was just changed, and every other session was signed out.", "If this wasn't you, reset your password from the sign-in page straight away and contact your administrator."] });
    await tx.verificationToken.deleteMany({ where: { identifier: `reset:${email}` } });
    return true;
  });
  if (!result) return { ok: false, error: "Invalid or expired reset link." };

  return { ok: true, data: { reset: true } };
}
