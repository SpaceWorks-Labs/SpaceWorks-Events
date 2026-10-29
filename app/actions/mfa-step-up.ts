"use server";

import { z } from "zod";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { requireAuth } from "@/lib/permissions";
import { decryptMfaSecret, consumeMfaCode } from "@/lib/mfa";
import { createMfaProof, MFA_PROOF_COOKIE, MFA_PROOF_MAX_AGE_SECONDS } from "@/lib/mfaProof";
import { currentSessionSid } from "@/lib/sessionSid";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import type { ActionResult } from "./org";

const schema = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Enter a six-digit authenticator code.") });

/** After a sign-in without an authenticator code (Google), staff confirm one here. */
export async function verifyStepUpMfa(input: unknown): Promise<ActionResult> {
  const session = await requireAuth();
  if (await isActionRateLimited("auth", session.user.id)) {
    return { ok: false, error: "Too many attempts. Please try again later." };
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Enter a six-digit authenticator code." };
  // The proof is bound to this browser's sign-in (lib/sessionSid.ts); without one there is nothing to bind it to.
  const sid = await currentSessionSid(session.user.id);
  if (!sid) return { ok: false, error: "Sign in again, then confirm your authenticator code." };

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, mfaSecretEncrypted: true, mfaEnabledAt: true, sessionVersion: true },
  });
  if (!user?.email || !user.mfaEnabledAt || !user.mfaSecretEncrypted) {
    return { ok: false, error: "Set up an authenticator app in Account security first." };
  }

  let valid = false;
  try {
    valid = await consumeMfaCode(decryptMfaSecret(user.mfaSecretEncrypted), user.email, parsed.data.code);
  } catch {
    return { ok: false, error: "Could not verify the authenticator code. Start again or contact an administrator." };
  }
  if (!valid) return { ok: false, error: "Invalid authenticator code." };

  (await cookies()).set(MFA_PROOF_COOKIE, createMfaProof(session.user.id, user.sessionVersion, sid), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MFA_PROOF_MAX_AGE_SECONDS,
    priority: "high",
  });
  await prisma.auditEvent.create({
    data: { action: "MFA_STEP_UP_VERIFIED", actorUserId: session.user.id, targetType: "User", targetId: session.user.id },
  });
  return { ok: true };
}
