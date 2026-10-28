import { z } from "zod";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { consumeMfaCode, consumeRecoveryCode, decryptMfaSecret } from "@/lib/mfa";
import { markMobileSessionMfaVerified } from "@/lib/mobileAuth";
import { mobileError, mobileOk, readJsonBody } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

const bodySchema = z.object({ code: z.string().trim().min(6).max(32) }).strict();

/**
 * Confirm an authenticator (or recovery) code on this app session, as staff
 * do on /verify-mfa after a Google sign-in. Valid for 12 hours of staff
 * access. Limited by the web's own `auth` bucket (per address and per
 * account) and per address for the app. Recovery codes work once each, as on
 * the web; failures and recovery-code use are audited (never the code).
 * Setting an authenticator up stays on the website.
 */
export const POST = authedMobileRoute("POST /api/mobile/v1/auth/mfa", async (request, _params, { auth }) => {
  if (!(await checkRateLimitById("mobileAuth", `ip:${getClientIpFromHeaders(request.headers)}`))) return mobileError("RATE_LIMITED");
  if (await isActionRateLimited("auth", auth.userId)) return mobileError("RATE_LIMITED");
  const body = await readJsonBody(request, 4 * 1024);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) return mobileError("INVALID_REQUEST", "Enter the code from your authenticator app.");
  const user = await prisma.user.findUnique({ where: { id: auth.userId }, select: { email: true, mfaSecretEncrypted: true } });
  if (!user?.email || !user.mfaSecretEncrypted) return mobileError("STAFF_MFA_ENROLMENT_REQUIRED");
  const totp = await consumeMfaCode(decryptMfaSecret(user.mfaSecretEncrypted), user.email, parsed.data.code);
  const recovery = !totp && await consumeRecoveryCode(auth.userId, parsed.data.code);
  const audit = (action: string) => recordAuditEvent({ action, actorUserId: auth.userId, targetType: "MobileSession", targetId: auth.sessionId });
  if (!totp && !recovery) {
    await audit("MOBILE_MFA_FAILED");
    return mobileError("INVALID_REQUEST", "That code didn't work. Wait for the next code and try again.");
  }
  if (recovery) await audit("MOBILE_MFA_RECOVERY_CODE_USED");
  const verifiedAt = await markMobileSessionMfaVerified(auth);
  return mobileOk({ mfaVerifiedAt: verifiedAt.toISOString() });
});
