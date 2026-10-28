import { z } from "zod";
import { verifyPasswordSignIn } from "@/lib/credentialsAuth";
import { deviceHash } from "@/lib/loginSecurity";
import { issueMobileSession } from "@/lib/mobileAuth";
import { mobileError, mobileOk, readJsonBody, zodFieldErrors } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { deviceFieldsSchema, sessionDto } from "@/lib/mobile/session";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

const INVALID = "Email or password is incorrect.";
const bodySchema = z.object({
  email: z.string().max(254),
  password: z.string().max(128),
  totp: z.string().max(32).optional(),
  /** The six-digit code emailed after EMAIL_CODE_REQUIRED. */
  emailCode: z.string().max(12).optional(),
  ...deviceFieldsSchema,
}).strict();

/**
 * Password sign-in with every web protection (lib/credentialsAuth.ts): the
 * address and account failure limits, an emailed code for a new install or
 * an account under attack (EMAIL_CODE_REQUIRED, then retry with `emailCode`),
 * the new sign-in alert and the authenticator (MFA_REQUIRED, then `totp`).
 * A sign-in with an authenticator code also satisfies the staff check.
 */
export const POST = mobileRoute("POST /api/mobile/v1/auth/login", async (request, _params, { baseUrl }) => {
  const ip = getClientIpFromHeaders(request.headers);
  if (!(await checkRateLimitById("mobileAuth", `ip:${ip}`))) return mobileError("RATE_LIMITED", "Too many sign-in attempts. Try again shortly.");
  const body = await readJsonBody(request, 16 * 1024);
  if ("response" in body) return body.response;
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) {
    // Only the install id's shape is explained; anything else is the generic refusal.
    const device = parsed.error.issues.some((issue) => issue.path[0] === "deviceId");
    return device ? mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(parsed.error) }) : mobileError("UNAUTHENTICATED", INVALID);
  }

  const { email, password, totp, emailCode, deviceId } = parsed.data;
  const result = await verifyPasswordSignIn({ email, password, totp, emailCode, device: deviceId }, { ip, userAgent: request.headers.get("user-agent") ?? "" });
  if (!result.ok) {
    if (result.reason === "too_many_attempts") return mobileError("TOO_MANY_ATTEMPTS");
    if (result.reason === "mfa_required") return mobileError("MFA_REQUIRED");
    if (result.reason === "email_verification_required") return mobileError("EMAIL_VERIFICATION_REQUIRED");
    if (result.reason === "email_code_required") return mobileError("EMAIL_CODE_REQUIRED");
    return mobileError("UNAUTHENTICATED", INVALID);
  }

  const issued = await issueMobileSession({
    userId: result.user.id,
    verifiedSessionVersion: result.user.sessionVersion,
    deviceHash: deviceHash(deviceId)!,
    deviceName: parsed.data.deviceName,
    platform: parsed.data.platform,
    method: "password",
    mfaVerified: result.user.mfaVerified,
  });
  if (!issued) return mobileError("UNAUTHENTICATED", INVALID);
  return mobileOk(await sessionDto(issued, result.user.id, baseUrl));
});
