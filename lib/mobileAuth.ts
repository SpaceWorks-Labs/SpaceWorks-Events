import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  generateMobileTokenPair,
  hashMobileToken,
  isAccessUsable,
  isRefreshTokenShape,
  isRefreshUsable,
  parseMobileBearer,
} from "@/lib/mobile/tokens";
import type { MobileRequestActor } from "@/lib/requestActor";

/*
 * Space Works mobile app sessions (Android and iOS). These are individual
 * users, not machine clients: every request resolves the user and then runs
 * as a request actor (lib/requestActor.ts) through the same permission
 * helpers as the website. Tokens are never logged or audited, and only their
 * SHA-256 digests are stored. A session records the install id the app sent
 * (`deviceHash`) and refreshes must send the same one. The id is
 * client-supplied: it stops a refresh token replayed without it, not one
 * copied together with the id.
 */

export type MobilePlatform = "android" | "ios";

export type IssuedMobileSession = {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};

export type MobileAuthContext = MobileRequestActor;

const LAST_USED_THROTTLE_MS = 5 * 60_000;
/**
 * A refresh whose response was lost (common on venue Wi-Fi) is retried with
 * the previous token. Inside this window that retry is refused without
 * revoking; afterwards a replay is treated as theft.
 */
export const REFRESH_REUSE_GRACE_MS = 30_000;
/** How many rotated-away refresh tokens are remembered; replaying any of them revokes the session. */
export const MOBILE_REFRESH_HISTORY = 3;
/** "Sign out everywhere" from the app needs a credential proved this recently. */
export const MOBILE_RECENT_AUTH_MS = 10 * 60_000;

/**
 * Create a session bound to the `sessionVersion` that was current when the
 * credential was verified. A password reset or "sign out everywhere" racing
 * the sign-in must not mint a session from the old proof, exactly like the
 * web JWT callback.
 */
export async function issueMobileSession(params: {
  userId: string;
  verifiedSessionVersion: number;
  deviceHash: string;
  deviceName?: string | null;
  platform?: MobilePlatform | null;
  method: "password" | "google";
  /** An authenticator code was checked as part of this sign-in. */
  mfaVerified: boolean;
}): Promise<IssuedMobileSession | null> {
  const tokens = generateMobileTokenPair();
  const now = new Date();
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: params.userId }, select: { sessionVersion: true } });
    if (!user || user.sessionVersion !== params.verifiedSessionVersion) return null;
    const session = await tx.mobileSession.create({
      data: {
        userId: params.userId,
        accessTokenHash: tokens.accessTokenHash,
        refreshTokenHash: tokens.refreshTokenHash,
        sessionVersion: user.sessionVersion,
        deviceHash: params.deviceHash,
        deviceName: params.deviceName?.trim().slice(0, 80) || null,
        platform: params.platform ?? null,
        authenticatedAt: now,
        mfaVerifiedAt: params.mfaVerified ? now : null,
        accessExpiresAt: tokens.accessExpiresAt,
        refreshExpiresAt: tokens.refreshExpiresAt,
      },
      select: { id: true },
    });
    await recordAuditEvent({
      action: "MOBILE_SIGNED_IN",
      actorUserId: params.userId,
      targetType: "MobileSession",
      targetId: session.id,
      metadata: { method: params.method, platform: params.platform ?? null, mfa: params.mfaVerified },
      client: tx,
    });
    return session;
  });
  if (!created) return null;
  return {
    sessionId: created.id,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: tokens.accessExpiresAt,
    refreshToken: tokens.refreshToken,
    refreshTokenExpiresAt: tokens.refreshExpiresAt,
  };
}

export type RefreshOutcome =
  | { ok: true; userId: string; session: IssuedMobileSession }
  | { ok: false; reason: "invalid" | "reused" };

async function revokeReplayed(replayed: { id: string; userId: string; }, now: Date) {
  await prisma.$transaction(async (tx) => {
    const revoked = await tx.mobileSession.updateMany({ where: { id: replayed.id, revokedAt: null }, data: { revokedAt: now } });
    if (revoked.count === 1) {
      await recordAuditEvent({ action: "MOBILE_REFRESH_TOKEN_REUSED", actorUserId: replayed.userId, targetType: "MobileSession", targetId: replayed.id, client: tx });
    }
  });
}

/**
 * Rotate a refresh token. It must come from the install that holds the
 * session. Presenting the refresh token that was rotated away revokes the
 * whole session (the token was copied), except within REFRESH_REUSE_GRACE_MS
 * of the rotation, when it is a likely retry after a lost response and is
 * refused without revoking. Every failure looks the same to the client.
 */
export async function refreshMobileSession(refreshToken: string, deviceHash: string | null): Promise<RefreshOutcome> {
  if (!isRefreshTokenShape(refreshToken) || !deviceHash) return { ok: false, reason: "invalid" };
  const presentedHash = hashMobileToken(refreshToken);
  const now = new Date();

  const session = await prisma.mobileSession.findUnique({
    where: { refreshTokenHash: presentedHash },
    select: {
      id: true, userId: true, revokedAt: true, accessExpiresAt: true, refreshExpiresAt: true,
      sessionVersion: true, deviceHash: true, previousRefreshTokenHashes: true, user: { select: { sessionVersion: true } },
    },
  });

  if (!session) {
    const replayed = await prisma.mobileSession.findFirst({
      where: { previousRefreshTokenHashes: { has: presentedHash } },
      select: { id: true, userId: true, revokedAt: true, rotatedAt: true, deviceHash: true, previousRefreshTokenHashes: true },
    });
    if (!replayed || replayed.revokedAt) return { ok: false, reason: "invalid" };
    // Only the token rotated away last can be an innocent retry after a lost response.
    const newest = replayed.previousRefreshTokenHashes[0] === presentedHash;
    const withinGrace = newest && replayed.rotatedAt && now.getTime() - replayed.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS;
    if (withinGrace && replayed.deviceHash === deviceHash) return { ok: false, reason: "invalid" };
    await revokeReplayed(replayed, now);
    return { ok: false, reason: "reused" };
  }

  if (session.deviceHash !== deviceHash) {
    // The current refresh token presented from another install was copied.
    await revokeReplayed(session, now);
    return { ok: false, reason: "reused" };
  }
  if (!isRefreshUsable(session, session.user.sessionVersion, now)) return { ok: false, reason: "invalid" };

  const tokens = generateMobileTokenPair(now);
  // The refresh-token hash in the predicate makes rotation single-winner when
  // two requests race with the same token.
  const rotated = await prisma.mobileSession.updateMany({
    where: { id: session.id, refreshTokenHash: presentedHash, revokedAt: null, sessionVersion: session.user.sessionVersion },
    data: {
      accessTokenHash: tokens.accessTokenHash,
      refreshTokenHash: tokens.refreshTokenHash,
      previousRefreshTokenHashes: [presentedHash, ...session.previousRefreshTokenHashes].slice(0, MOBILE_REFRESH_HISTORY),
      rotatedAt: now,
      accessExpiresAt: tokens.accessExpiresAt,
      refreshExpiresAt: tokens.refreshExpiresAt,
      lastUsedAt: now,
    },
  });
  if (rotated.count !== 1) return { ok: false, reason: "invalid" };

  return {
    ok: true,
    userId: session.userId,
    session: {
      sessionId: session.id,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessExpiresAt,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshExpiresAt,
    },
  };
}

/**
 * Authenticate a mobile request from its bearer access token. Expired,
 * revoked, unknown and version-stale tokens all return null so callers send
 * one generic 401.
 */
export async function requireMobileUser(request: Request): Promise<MobileAuthContext | null> {
  const token = parseMobileBearer(request.headers.get("authorization"));
  if (!token) return null;
  const session = await prisma.mobileSession.findUnique({
    where: { accessTokenHash: hashMobileToken(token) },
    select: {
      id: true, userId: true, revokedAt: true, accessExpiresAt: true, refreshExpiresAt: true,
      sessionVersion: true, lastUsedAt: true, mfaVerifiedAt: true, authenticatedAt: true,
      user: { select: { sessionVersion: true } },
    },
  });
  const now = new Date();
  if (!session || !isAccessUsable(session, session.user.sessionVersion, now)) return null;

  if (now.getTime() - session.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    try {
      await prisma.mobileSession.updateMany({
        where: { id: session.id, lastUsedAt: { lt: new Date(now.getTime() - LAST_USED_THROTTLE_MS) } },
        data: { lastUsedAt: now },
      });
    } catch {
      // Usage tracking is best effort and never changes authentication.
    }
  }
  return {
    kind: "mobile",
    userId: session.userId,
    sessionId: session.id,
    mfaVerifiedAt: session.mfaVerifiedAt,
    authenticatedAt: session.authenticatedAt,
  };
}

/** Optional identity for public routes: a bearer, if sent and valid, identifies the attendee. */
export async function optionalMobileUser(request: Request): Promise<MobileAuthContext | null> {
  if (!request.headers.get("authorization")) return null;
  return requireMobileUser(request);
}

/** Record a passed authenticator check on this app session. */
export async function markMobileSessionMfaVerified(context: MobileAuthContext) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.mobileSession.updateMany({ where: { id: context.sessionId, userId: context.userId, revokedAt: null }, data: { mfaVerifiedAt: now } });
    if (updated.count === 1) {
      await recordAuditEvent({ action: "MOBILE_MFA_VERIFIED", actorUserId: context.userId, targetType: "MobileSession", targetId: context.sessionId, client: tx });
    }
  });
  return now;
}

export async function revokeMobileSession(context: Pick<MobileAuthContext, "userId" | "sessionId">) {
  await prisma.$transaction(async (tx) => {
    const revoked = await tx.mobileSession.updateMany({
      where: { id: context.sessionId, userId: context.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (revoked.count === 1) {
      await recordAuditEvent({ action: "MOBILE_SIGNED_OUT", actorUserId: context.userId, targetType: "MobileSession", targetId: context.sessionId, client: tx });
    }
  });
}

/**
 * Mark every live mobile session of a user revoked. Bumping `sessionVersion`
 * already invalidates them; this keeps the rows truthful for support and
 * retention. Call inside the transaction that bumps the version.
 */
export function revokeUserMobileSessions(client: Prisma.TransactionClient, userId: string) {
  return client.mobileSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
