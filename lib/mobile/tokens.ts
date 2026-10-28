import crypto from "node:crypto";

/*
 * Pure helpers for mobile (Android and iOS) session tokens. Tokens are 32
 * random bytes, base64url encoded, behind a short type prefix so an access
 * token can never be accepted as a refresh token (or a machine API credential).
 * Only the SHA-256 digest of a token is ever persisted.
 */

export const ACCESS_TOKEN_PREFIX = "swa_";
export const REFRESH_TOKEN_PREFIX = "swr_";
export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60_000;

const ACCESS_PATTERN = /^swa_[A-Za-z0-9_-]{43}$/;
const REFRESH_PATTERN = /^swr_[A-Za-z0-9_-]{43}$/;

export function hashMobileToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function randomToken(prefix: string) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

export function generateMobileTokenPair(now = new Date()) {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
  return {
    accessToken,
    refreshToken,
    accessTokenHash: hashMobileToken(accessToken),
    refreshTokenHash: hashMobileToken(refreshToken),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
  };
}

export function isAccessTokenShape(value: string) {
  return ACCESS_PATTERN.test(value);
}

export function isRefreshTokenShape(value: string) {
  return REFRESH_PATTERN.test(value);
}

/** Reads `Authorization: Bearer <access token>`; anything else is null. */
export function parseMobileBearer(header: string | null): string | null {
  const match = header?.trim().match(/^Bearer[ \t]+([^ \t]+)$/i);
  const token = match?.[1];
  return token && isAccessTokenShape(token) ? token : null;
}

export type MobileSessionState = {
  revokedAt: Date | null;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  sessionVersion: number;
};

/** Whether a stored session may authenticate an access token right now. */
export function isAccessUsable(session: MobileSessionState, userSessionVersion: number, now = new Date()) {
  return !session.revokedAt
    && session.accessExpiresAt > now
    && session.refreshExpiresAt > now
    && session.sessionVersion === userSessionVersion;
}

/** Whether a stored session may be refreshed right now. */
export function isRefreshUsable(session: MobileSessionState, userSessionVersion: number, now = new Date()) {
  return !session.revokedAt
    && session.refreshExpiresAt > now
    && session.sessionVersion === userSessionVersion;
}
