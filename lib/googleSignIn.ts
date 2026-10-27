import "server-only";

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { prisma } from "@/lib/db";
import { getGoogleSsoSettings, getMobileGoogleClientIds, isNewUserRegistrationEnabled } from "@/lib/instanceSettings";

/*
 * Google sign-in policy shared by the web Auth.js callback and the mobile
 * ID-token exchange: verified email only, never link to an unverified
 * password account, and create new accounts only while the instance allows it.
 */

export type GoogleSignInDecision = "allow" | "deny" | "account_creation_disabled";

export async function evaluateGoogleSignIn(params: {
  email: string | null | undefined;
  emailVerified: boolean;
  providerAccountId: string;
}): Promise<GoogleSignInDecision> {
  if (!params.emailVerified) return "deny";
  const email = params.email?.trim().toLowerCase();
  if (!email) return "deny";
  const existing = await prisma.user.findUnique({
    where: { email }, select: { passwordHash: true, emailVerified: true },
  });
  // A pre-registered, unverified password must never survive linking to
  // the real inbox owner's Google identity.
  if (existing?.passwordHash && !existing.emailVerified) return "deny";

  const existingAccount = await prisma.account.findUnique({
    where: { provider_providerAccountId: { provider: "google", providerAccountId: params.providerAccountId } },
    select: { id: true },
  });
  if (existingAccount || existing) return "allow";

  // A verified Google identity may create an account only while the
  // instance-wide account-creation policy permits it.
  if (!(await isNewUserRegistrationEnabled())) return "account_creation_disabled";
  return "allow";
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");
let googleKeySet: JWTVerifyGetKey | null = null;

function defaultGoogleKeySet() {
  googleKeySet ??= createRemoteJWKSet(GOOGLE_JWKS_URL);
  return googleKeySet;
}

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
};

/**
 * Mobile Google sign-in is available when web Google SSO is configured. The
 * accepted audiences are the web client id plus the app client ids (Super
 * admin -> Settings, else `GOOGLE_MOBILE_CLIENT_IDS`).
 */
export type MobileGoogleConfig = { webClientId: string; mobileClientIds: string[] };

export async function getMobileGoogleConfig(): Promise<MobileGoogleConfig | null> {
  const settings = await getGoogleSsoSettings();
  if (!settings) return null;
  return { webClientId: settings.clientId, mobileClientIds: await getMobileGoogleClientIds() };
}

/**
 * Verify a Google ID token's signature (Google JWKS), issuer, expiry and
 * audience, and require a verified email. `aud` must be the web client id or
 * a mobile client id. When the app requested the token for the web client id
 * (the usual Android/iOS "server client id" flow) and mobile client ids are
 * configured, the authorised party `azp` must be one of them, so a token
 * minted for some other client of the web id is refused. Returns null on any
 * failure.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  config: MobileGoogleConfig,
  keySet: JWTVerifyGetKey = defaultGoogleKeySet(),
): Promise<GoogleIdentity | null> {
  const audiences = Array.from(new Set([config.webClientId, ...config.mobileClientIds].filter(Boolean)));
  if (audiences.length === 0 || idToken.length > 8192) return null;
  try {
    const { payload } = await jwtVerify(idToken, keySet, {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 30,
    });
    if (payload.email_verified !== true) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (aud.includes(config.webClientId) && config.mobileClientIds.length > 0) {
      if (typeof payload.azp !== "string" || !config.mobileClientIds.includes(payload.azp)) return null;
    }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email || typeof payload.sub !== "string" || !payload.sub) return null;
    return {
      sub: payload.sub,
      email,
      name: typeof payload.name === "string" ? payload.name.slice(0, 120) : null,
      picture: typeof payload.picture === "string" && payload.picture.startsWith("https://") ? payload.picture.slice(0, 2048) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Sign in, link or create the Space Works user for a verified Google identity with
 * the same outcome as Auth.js (`allowDangerousEmailAccountLinking` scoped to
 * Google, identity-only account rows, email marked verified after sign-in).
 * Call only after `evaluateGoogleSignIn` returned "allow".
 */
export async function completeGoogleSignIn(identity: GoogleIdentity): Promise<{ id: string; sessionVersion: number } | null> {
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findUnique({
      where: { provider_providerAccountId: { provider: "google", providerAccountId: identity.sub } },
      select: { userId: true },
    });
    let userId = account?.userId ?? null;
    if (!userId) {
      const existing = await tx.user.findUnique({
        where: { email: identity.email },
        select: { id: true, passwordHash: true, emailVerified: true },
      });
      // Recheck at linking time, as the web adapter does: registration can
      // race the policy check.
      if (existing?.passwordHash && !existing.emailVerified) return null;
      if (existing) {
        userId = existing.id;
      } else {
        const created = await tx.user.create({
          data: { email: identity.email, name: identity.name, image: identity.picture },
          select: { id: true },
        });
        userId = created.id;
      }
      // Google is used only for identity. Do not retain reusable OAuth tokens.
      await tx.account.create({
        data: { userId, type: "oidc", provider: "google", providerAccountId: identity.sub },
      });
    }
    const user = await tx.user.update({
      where: { id: userId },
      data: { emailVerified: new Date() },
      select: { id: true, sessionVersion: true },
    });
    return user;
  });
}
