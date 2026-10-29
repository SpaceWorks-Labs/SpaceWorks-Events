import "server-only";

import { randomBytes } from "node:crypto";
import NextAuth, { CredentialsSignin } from "next-auth";
import { authAdapter } from "@/lib/authAdapter";
import Google from "next-auth/providers/google";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import { verifyPasswordSignIn } from "@/lib/credentialsAuth";
import { hasVerifiedGoogleEmail } from "@/lib/googleAuth";
import { evaluateGoogleSignIn } from "@/lib/googleSignIn";
import { getClientIpFromHeaders } from "@/lib/rateLimit";
import { getGoogleSsoSettings } from "@/lib/instanceSettings";
import { logAuthError } from "@/lib/authLogger";
import { actorSession } from "@/lib/actorSession";
import { currentRequestActor } from "@/lib/requestActor";
import { SESSION_COOKIE_NAME } from "@/lib/sessionSid";
import type { Session } from "next-auth";

type AuthMethod = Session["authMethod"];

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

const nextAuth = NextAuth(async () => {
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
    sessionToken: { name: SESSION_COOKIE_NAME },
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
        const outcome = await verifyPasswordSignIn(raw, {
          ip: request?.headers ? getClientIpFromHeaders(request.headers) : "unknown",
          userAgent: request?.headers?.get("user-agent") ?? "",
        });
        if (outcome.ok) return outcome.user;
        if (outcome.reason === "mfa_required") throw new MfaRequiredError();
        if (outcome.reason === "email_verification_required") throw new EmailVerificationRequiredError();
        if (outcome.reason === "email_code_required") throw new EmailCodeRequiredError();
        if (outcome.reason === "too_many_attempts") throw new TooManyAttemptsError();
        return null;
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "google") return true;
      const decision = await evaluateGoogleSignIn({ email: user.email, emailVerified: hasVerifiedGoogleEmail(profile), providerAccountId: account.providerAccountId });
      if (decision === "deny") return false;
      user.email = user.email!.trim().toLowerCase();
      // Returning true lets Auth.js create or link the adapter user after this callback.
      return decision === "account_creation_disabled" ? "/login?error=account_creation_disabled" : true;
    },
    async jwt({ token, user, account }) {
      const userId = user?.id ?? token.sub;
      if (!userId) return null;

      const currentUser = await prisma.user.findUnique({
        where: { id: userId },
        select: { sessionVersion: true },
      });
      if (!currentUser) return null;

      const sessionToken = token as typeof token & { authenticatedAt?: number; sessionVersion?: number; sessionRevoked?: boolean; mfaVerified?: boolean; sid?: string; authMethod?: AuthMethod };
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
        // How this sign-in happened; the super admin gate accepts only a password.
        sessionToken.authMethod = account?.provider === "google" ? "google" : account?.provider === "credentials" ? "credentials" : undefined;
        // This sign-in's id, fixed for the session's life: an MFA proof is
        // bound to it (lib/mfaProof.ts), so a new sign-in needs a new proof.
        // Read on the server only (lib/sessionSid.ts), never via the session.
        sessionToken.sid = randomBytes(16).toString("base64url");
      } else if (sessionToken.sessionRevoked || sessionToken.sessionVersion !== currentUser.sessionVersion || !sessionToken.sid) {
        // Auth.js clears the cookie and returns a genuinely anonymous session.
        // A token from before sign-in ids existed is retired the same way.
        return null;
      }
      return token;
    },
    session({ session, token }) {
      const sessionToken = token as typeof token & { authenticatedAt?: number; sessionRevoked?: boolean; mfaVerified?: boolean; authMethod?: AuthMethod };
      if (session.user && token.sub && !sessionToken.sessionRevoked) session.user.id = token.sub;
      if (sessionToken.sessionRevoked && session.user) session.user.id = "";
      (session as typeof session & { authenticatedAt?: number }).authenticatedAt =
        sessionToken.authenticatedAt;
      (session as typeof session & { mfaVerified?: boolean }).mfaVerified = sessionToken.mfaVerified === true;
      // The sid stays in the token: this object is what /api/auth/session returns.
      session.authMethod = sessionToken.authMethod;
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

export const { handlers, signIn, signOut } = nextAuth;

/**
 * The signed-in session. Inside a mobile API request (lib/requestActor.ts)
 * there is no cookie: the app session that authenticated the bearer token is
 * presented as the session instead, so Server Action bodies run unchanged for
 * the app with every payment, refund, webhook and notification rule intact.
 * Its `mfaVerified` and `authenticatedAt` come from the app session.
 */
export async function auth(): Promise<Session | null> {
  const actor = currentRequestActor();
  if (!actor) return nextAuth.auth();
  // A mobile request without a bearer is signed out, never the cookie session.
  return actor.kind === "mobile" ? actorSession(actor) : null;
}
