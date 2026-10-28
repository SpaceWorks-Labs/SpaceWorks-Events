import { describe, expect, it } from "vitest";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  generateMobileTokenPair,
  hashMobileToken,
  isAccessTokenShape,
  isAccessUsable,
  isRefreshTokenShape,
  isRefreshUsable,
  parseMobileBearer,
} from "@/lib/mobile/tokens";

describe("mobile session tokens", () => {
  it("issues 32-byte base64url tokens with distinct prefixes and stores only SHA-256 digests", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const pair = generateMobileTokenPair(now);
    expect(pair.accessToken).toMatch(/^swa_[A-Za-z0-9_-]{43}$/);
    expect(pair.refreshToken).toMatch(/^swr_[A-Za-z0-9_-]{43}$/);
    expect(pair.accessTokenHash).toBe(hashMobileToken(pair.accessToken));
    expect(pair.accessTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pair.accessTokenHash).not.toContain(pair.accessToken.slice(4));
    expect(pair.accessExpiresAt.getTime() - now.getTime()).toBe(ACCESS_TOKEN_TTL_MS);
    expect(pair.refreshExpiresAt.getTime() - now.getTime()).toBe(REFRESH_TOKEN_TTL_MS);
    expect(generateMobileTokenPair(now).accessToken).not.toBe(pair.accessToken);
  });

  it("never accepts a refresh token as an access token or vice versa", () => {
    const pair = generateMobileTokenPair();
    expect(isAccessTokenShape(pair.accessToken)).toBe(true);
    expect(isAccessTokenShape(pair.refreshToken)).toBe(false);
    expect(isRefreshTokenShape(pair.refreshToken)).toBe(true);
    expect(isRefreshTokenShape(pair.accessToken)).toBe(false);
    expect(parseMobileBearer(`Bearer ${pair.refreshToken}`)).toBeNull();
    expect(parseMobileBearer(`Bearer ${pair.accessToken}`)).toBe(pair.accessToken);
    expect(parseMobileBearer(`bearer   ${pair.accessToken}`)).toBe(pair.accessToken);
    expect(parseMobileBearer(`Basic ${pair.accessToken}`)).toBeNull();
    expect(parseMobileBearer("Bearer yuyu_v1_abc.def")).toBeNull();
    expect(parseMobileBearer(null)).toBeNull();
  });

  it("rejects revoked, expired and version-stale sessions", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    const live = {
      revokedAt: null,
      accessExpiresAt: new Date(now.getTime() + 60_000),
      refreshExpiresAt: new Date(now.getTime() + 3_600_000),
      sessionVersion: 3,
    };
    expect(isAccessUsable(live, 3, now)).toBe(true);
    expect(isAccessUsable(live, 4, now)).toBe(false);
    expect(isAccessUsable({ ...live, revokedAt: now }, 3, now)).toBe(false);
    expect(isAccessUsable({ ...live, accessExpiresAt: now }, 3, now)).toBe(false);
    expect(isRefreshUsable({ ...live, accessExpiresAt: new Date(0) }, 3, now)).toBe(true);
    expect(isRefreshUsable(live, 4, now)).toBe(false);
    expect(isRefreshUsable({ ...live, refreshExpiresAt: now }, 3, now)).toBe(false);
  });
});
