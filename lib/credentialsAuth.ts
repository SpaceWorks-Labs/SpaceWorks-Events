import "server-only";

import bcrypt from "bcryptjs";
import { z } from "zod";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { prisma } from "@/lib/db";
import {
  accountLocked, accountUnderAttack, consumeSignInCode, deviceHash, isAddressBlocked, knownDevice,
  newDeviceCheckEnabled, noteFailedSignIn, rememberSignIn, sendSignInCode,
} from "@/lib/loginSecurity";
import { consumeMfaCode, consumeRecoveryCode, decryptMfaSecret } from "@/lib/mfa";

/*
 * Email and password sign-in, shared by the web (Auth.js Credentials) and the
 * mobile API so both keep every protection: address and account failure
 * limits, an emailed code for a new device or an account under attack, new
 * sign-in alerts, and the authenticator check. Every outcome other than
 * "invalid" is reported only after the password was right.
 */

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  totp: z.string().trim().max(32).optional(),
  /** The browser's (or app install's) random device id (see lib/loginSecurity). */
  device: z.string().trim().max(64).optional(),
  /** The code emailed for an unusual sign-in. */
  emailCode: z.string().trim().max(12).optional(),
});

export type CredentialsRefusal =
  | "invalid"
  | "mfa_required"
  | "email_verification_required"
  | "email_code_required"
  | "too_many_attempts";

export type VerifiedCredentialsUser = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  sessionVersion: number;
  /** An authenticator (or recovery) code was checked as part of this sign-in. */
  mfaVerified: boolean;
};

export type CredentialsOutcome = { ok: true; user: VerifiedCredentialsUser } | { ok: false; reason: CredentialsRefusal };

// A fixed non-secret dummy hash: equal bcrypt work for missing and OAuth-only
// accounts prevents the obvious timing oracle.
const DUMMY_HASH = "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW";

export async function verifyPasswordSignIn(raw: unknown, context: { ip: string; userAgent: string; }): Promise<CredentialsOutcome> {
  const parsed = credentialsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const { email, password } = parsed.data;
  const { ip } = context;
  if (await isAddressBlocked(ip)) return { ok: false, reason: "too_many_attempts" };
  if (await isActionRateLimited("auth", email)) return { ok: false, reason: "invalid" };

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, image: true, passwordHash: true, sessionVersion: true, emailVerified: true, mfaSecretEncrypted: true },
  });
  const ok = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user?.passwordHash || !ok) {
    await noteFailedSignIn(ip, email);
    return { ok: false, reason: "invalid" };
  }
  if (!user.emailVerified) return { ok: false, reason: "email_verification_required" };
  if (!user.email) return { ok: false, reason: "invalid" };

  let mfaVerified = false;
  if (user.mfaSecretEncrypted) {
    const code = parsed.data.totp ?? "";
    if (!code) return { ok: false, reason: "mfa_required" };
    const validTotp = await consumeMfaCode(decryptMfaSecret(user.mfaSecretEncrypted), user.email, code);
    if (!validTotp && !(await consumeRecoveryCode(user.id, code))) {
      await noteFailedSignIn(ip, email);
      return { ok: false, reason: "invalid" };
    }
    mfaVerified = true;
  }

  // An authenticator code is proof enough. Otherwise a device this account
  // hasn't used (after its first), or recent failures, need an emailed code.
  const hash = deviceHash(parsed.data.device);
  const { known, firstDevice } = await knownDevice(user.id, hash);
  if (newDeviceCheckEnabled() && !mfaVerified && ((!known && !firstDevice) || (await accountUnderAttack(email)))) {
    if (await accountLocked(email)) return { ok: false, reason: "too_many_attempts" };
    const emailCode = parsed.data.emailCode ?? "";
    if (!emailCode) {
      if (!(await sendSignInCode({ id: user.id, email: user.email }))) return { ok: false, reason: "too_many_attempts" };
      return { ok: false, reason: "email_code_required" };
    }
    if (!(await consumeSignInCode(user.id, emailCode))) {
      await noteFailedSignIn(ip, email);
      return { ok: false, reason: "invalid" };
    }
  }
  await rememberSignIn({ userId: user.id, email: user.email, hash, ip, userAgent: context.userAgent, firstDevice });

  return {
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, image: user.image, sessionVersion: user.sessionVersion, mfaVerified },
  };
}
