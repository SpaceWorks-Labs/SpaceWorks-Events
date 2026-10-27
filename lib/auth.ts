import "server-only";

import NextAuth, { CredentialsSignin } from "next-auth";
import { authAdapter } from "@/lib/authAdapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hasVerifiedGoogleEmail } from "@/lib/googleAuth";
import { consumeRecoveryCode, decryptMfaSecret, consumeMfaCode } from "@/lib/mfa";
import { isNewUserRegistrationEnabled } from "@/lib/instanceSettings";
import { getClientIpFromHeaders } from "@/lib/rateLimit";
import {
  accountLocked, accountUnderAttack, consumeSignInCode, deviceHash, isAddressBlocked, knownDevice,
  newDeviceCheckEnabled, noteFailedSignIn, rememberSignIn, sendSignInCode,
} from "@/lib/loginSecurity";
import { getGoogleSsoSettings } from "@/lib/instanceSettings";
import { logAuthError } from "@/lib/authLogger";

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
  totp: z.string().trim().max(32).optional(),
  /** The browser's random device id (see lib/loginSecurity). */
  device: z.string().trim().max(64).optional(),
  /** The code emailed for an unusual sign-in. */
  emailCode: z.string().trim().max(12).optional(),
});

/**
 * This code is returned only after the supplied password is valid. It lets the
 * sign-in screen show the second factor as a distinct step without exposing
 * whether an arbitrary email address has MFA enabled.
 */
class MfaRequiredError extends CredentialsSignin {
  code = "mfa_required";
}

class EmailVerificationRequiredError extends CredentialsSignin {
  code = "email_verification_required";
}

/** Also only after a valid password: the sign-in looks unusual, so a code was emailed. */
class EmailCodeRequiredError extends CredentialsSignin {
  code = "email_code_required";
}

/** This address (or account) failed too often recently. */
class TooManyAttemptsError extends CredentialsSignin {
  code = "too_many_attempts";
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const google = await getGoogleSsoSettings();
  return {
  adapter: authAdapter,
  // Credentials requires JWT sessions; OAuth accounts are still persisted
  // via the adapter's `linkAccount` hook.
  session: { strategy: "jwt" },
  // Changing the session payload/secret can leave an old encrypted cookie in
  // browsers. A versioned name retires that incompatible token cleanly rather
  // than asking Auth.js to decode it on every request.
  cookies: {
    sessionToken: { name: "swe.session-token.v1" },
  },
  trustHost: true,
  logger: {
    // Expected sign-in outcomes are skipped; see lib/authLogger.ts.
    error: logAuthError,
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  providers: [
    ...(google
      ? [
          Google({
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            // Existing password users can use the same verified Google email.
            // This is deliberately scoped to Google, never arbitrary providers.
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    Credentials({
      id: "credentials",
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw, request) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const { email, password } = parsed.data;
        const ip = request?.headers ? getClientIpFromHeaders(request.headers) : "unknown";
        if (await isAddressBlocked(ip)) throw new TooManyAttemptsError();
        if (await isActionRateLimited("auth", email)) return null;

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            passwordHash: true,
            sessionVersion: true,
            emailVerified: true,
            mfaSecretEncrypted: true,
          },
        });
        // Equal bcrypt work for missing and OAuth-only accounts prevents the
        // obvious timing oracle. This is a fixed non-secret dummy hash.
        const ok = await bcrypt.compare(password, user?.passwordHash ?? "$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW");
        if (!user?.passwordHash || !ok) {
          await noteFailedSignIn(ip, email);
          return null;
        }
        if (!user.emailVerified) throw new EmailVerificationRequiredError();
        if (!user.email) return null;

        let mfaVerified = false;
        if (user.mfaSecretEncrypted) {
          const code = parsed.data.totp ?? "";
          if (!code) throw new MfaRequiredError();
          const validTotp = await consumeMfaCode(decryptMfaSecret(user.mfaSecretEncrypted), user.email, code);
          if (!validTotp && !(await consumeRecoveryCode(user.id, code))) {
            await noteFailedSignIn(ip, email);
            return null;
          }
          mfaVerified = true;
        }

        // An authenticator code is proof enough. Otherwise a device this account
        // hasn't used (after its first), or recent failures, need an emailed code.
        const hash = deviceHash(parsed.data.device);
        const { known, firstDevice } = await knownDevice(user.id, hash);
        if (newDeviceCheckEnabled() && !mfaVerified && ((!known && !firstDevice) || (await accountUnderAttack(email)))) {
          if (await accountLocked(email)) throw new TooManyAttemptsError();
          const emailCode = parsed.data.emailCode ?? "";
          if (!emailCode) {
            if (!(await sendSignInCode({ id: user.id, email: user.email }))) throw new TooManyAttemptsError();
            throw new EmailCodeRequiredError();
          }
          if (!(await consumeSignInCode(user.id, emailCode))) {
            await noteFailedSignIn(ip, email);
            return null;
          }
        }
        await rememberSignIn({ userId: user.id, email: user.email, hash, ip, userAgent: request?.headers?.get("user-agent") ?? "", firstDevice });

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          sessionVersion: user.sessionVersion,
          mfaVerified,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;
      if (!hasVerifiedGoogleEmail(profile)) return false;
      const email = user.email?.trim().toLowerCase();
      if (!email) return false;
      user.email = email;
      const existing = await prisma.user.findUnique({
        where: { email }, select: { passwordHash: true, emailVerified: true },
      });
      // A pre-registered, unverified password must never survive linking to
      // the real inbox owner's Google identity.
      if (existing?.passwordHash && !existing.emailVerified) return false;

      const existingAccount = await prisma.account.findUnique({
        where: { provider_providerAccountId: { provider: account.provider, providerAccountId: account.providerAccountId } },
        select: { id: true },
      });
      if (existingAccount || existing) return true;

      // A verified Google identity may create an account only while the
      // instance-wide account-creation policy permits it. Returning true lets
      // Auth.js create the adapter user after this callback.
      if (!(await isNewUserRegistrationEnabled())) {
        return "/login?error=account_creation_disabled";
      }
      return true;
    },
    async jwt({ token, user }) {
      const userId = user?.id ?? token.sub;
      if (!userId) return null;

      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionVersion: true },
      });
      if (!currentUser) return null;

      const sessionToken = token as typeof token & { authenticatedAt?: number; sessionVersion?: number; sessionRevoked?: boolean; mfaVerified?: boolean };
      if (user) {
        // Bind credentials to the version checked with the password. A reset
        // racing token issuance must not mint a fresh session from old proof.
        const verifiedVersion = (user as typeof user & { sessionVersion?: number }).sessionVersion;
        if (verifiedVersion !== undefined && verifiedVersion !== currentUser.sessionVersion) return null;
        token.sub = user.id;
        sessionToken.authenticatedAt = Date.now();
        sessionToken.sessionVersion = currentUser.sessionVersion;
        sessionToken.sessionRevoked = false;
        // Set only by a password sign-in that included an authenticator code.
        sessionToken.mfaVerified = (user as typeof user & { mfaVerified?: boolean }).mfaVerified === true;
      } else if (sessionToken.sessionRevoked || sessionToken.sessionVersion !== currentUser.sessionVersion) {
        // Auth.js clears the cookie and returns a genuinely anonymous session.
        return null;
      }
      return token;
    },
    session({ session, token }) {
      const sessionToken = token as typeof token & { authenticatedAt?: number; sessionRevoked?: boolean; mfaVerified?: boolean };
      if (session.user && token.sub && !sessionToken.sessionRevoked) session.user.id = token.sub;
      if (sessionToken.sessionRevoked && session.user) session.user.id = "";
      (session as typeof session & { authenticatedAt?: number }).authenticatedAt =
        sessionToken.authenticatedAt;
      (session as typeof session & { mfaVerified?: boolean }).mfaVerified = sessionToken.mfaVerified === true;
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      if (account?.provider === "google") {
        // Auth.js creates or links the adapter user after callbacks.signIn.
        await prisma.user.update({ where: { id: user.id }, data: { emailVerified: new Date() } });
      }
    },
  },
  };
});
