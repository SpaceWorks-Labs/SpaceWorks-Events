import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashMobileToken } from "@/lib/mobile/tokens";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  audit: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ recordAuditEvent: mocks.audit }));
vi.mock("@/lib/db", () => ({
  prisma: {
    mobileSession: { findUnique: mocks.findUnique, findFirst: mocks.findUnique, updateMany: mocks.updateMany },
    $transaction: mocks.transaction,
  },
}));

import { REFRESH_REUSE_GRACE_MS, refreshMobileSession, requireMobileUser } from "@/lib/mobileAuth";

const ACCESS = `swa_${"a".repeat(43)}`;
const REFRESH = `swr_${"b".repeat(43)}`;
const future = () => new Date(Date.now() + 60_000);
const DEVICE = "d".repeat(64);

function liveSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "ms_1", userId: "user_1", revokedAt: null, accessExpiresAt: future(), refreshExpiresAt: future(),
    sessionVersion: 2, lastUsedAt: new Date(), mfaVerifiedAt: null, authenticatedAt: new Date(0), deviceHash: DEVICE, previousRefreshTokenHashes: [], user: { sessionVersion: 2 }, ...overrides,
  };
}

const request = (token: string) => new Request("https://events.example.test/api/mobile/v1/me", { headers: { authorization: `Bearer ${token}` } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({ mobileSession: { updateMany: mocks.updateMany } }));
  mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("requireMobileUser", () => {
  it("looks a session up by the access-token digest only", async () => {
    mocks.findUnique.mockResolvedValue(liveSession());
    await expect(requireMobileUser(request(ACCESS))).resolves.toEqual({ kind: "mobile", userId: "user_1", sessionId: "ms_1", mfaVerifiedAt: null, authenticatedAt: new Date(0) });
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { accessTokenHash: hashMobileToken(ACCESS) } }));
  });

  it("rejects a session whose version no longer matches the user (password change, sign out everywhere)", async () => {
    mocks.findUnique.mockResolvedValue(liveSession({ user: { sessionVersion: 3 } }));
    await expect(requireMobileUser(request(ACCESS))).resolves.toBeNull();
  });

  it("rejects revoked, expired, unknown and malformed tokens identically", async () => {
    mocks.findUnique.mockResolvedValueOnce(liveSession({ revokedAt: new Date() }));
    await expect(requireMobileUser(request(ACCESS))).resolves.toBeNull();
    mocks.findUnique.mockResolvedValueOnce(liveSession({ accessExpiresAt: new Date(Date.now() - 1) }));
    await expect(requireMobileUser(request(ACCESS))).resolves.toBeNull();
    mocks.findUnique.mockResolvedValueOnce(null);
    await expect(requireMobileUser(request(ACCESS))).resolves.toBeNull();
    await expect(requireMobileUser(request(REFRESH))).resolves.toBeNull();
    expect(mocks.findUnique).toHaveBeenCalledTimes(3);
  });

  it("throttles last-used updates", async () => {
    mocks.findUnique.mockResolvedValue(liveSession({ lastUsedAt: new Date() }));
    await requireMobileUser(request(ACCESS));
    expect(mocks.updateMany).not.toHaveBeenCalled();
    mocks.findUnique.mockResolvedValue(liveSession({ lastUsedAt: new Date(Date.now() - 10 * 60_000) }));
    await requireMobileUser(request(ACCESS));
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("refreshMobileSession", () => {
  it("rotates both tokens and remembers the replaced refresh digest", async () => {
    mocks.findUnique.mockResolvedValueOnce(liveSession());
    const outcome = await refreshMobileSession(REFRESH, DEVICE);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.session.refreshToken).not.toBe(REFRESH);
    const update = mocks.updateMany.mock.calls[0]![0];
    expect(update.where).toMatchObject({ id: "ms_1", refreshTokenHash: hashMobileToken(REFRESH), revokedAt: null });
    expect(update.data.previousRefreshTokenHashes).toEqual([hashMobileToken(REFRESH)]);
    expect(update.data.rotatedAt).toBeInstanceOf(Date);
    expect(update.data.refreshTokenHash).toBe(hashMobileToken(outcome.session.refreshToken));
    expect(JSON.stringify(update)).not.toContain(outcome.session.refreshToken);
  });

  it("refuses, without revoking, a retry of the previous token inside the grace window", async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "ms_1", userId: "user_1", revokedAt: null, rotatedAt: new Date(Date.now() - 5_000), deviceHash: DEVICE, previousRefreshTokenHashes: [hashMobileToken(REFRESH)] });
    await expect(refreshMobileSession(REFRESH, DEVICE)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("revokes the whole session when an already-rotated refresh token is replayed", async () => {
    mocks.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "ms_1", userId: "user_1", revokedAt: null, rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000), deviceHash: DEVICE, previousRefreshTokenHashes: [hashMobileToken(REFRESH)] });
    await expect(refreshMobileSession(REFRESH, DEVICE)).resolves.toEqual({ ok: false, reason: "reused" });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "ms_1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "MOBILE_REFRESH_TOKEN_REUSED" }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(REFRESH);
  });

  it("revokes a session whose refresh token is presented from another install", async () => {
    mocks.findUnique.mockResolvedValueOnce(liveSession());
    await expect(refreshMobileSession(REFRESH, "e".repeat(64))).resolves.toEqual({ ok: false, reason: "reused" });
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "ms_1", revokedAt: null }, data: { revokedAt: expect.any(Date) } });
    await expect(refreshMobileSession(REFRESH, null)).resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses version-stale and malformed refresh tokens", async () => {
    mocks.findUnique.mockResolvedValueOnce(liveSession({ user: { sessionVersion: 9 } }));
    await expect(refreshMobileSession(REFRESH, DEVICE)).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(refreshMobileSession(ACCESS, DEVICE)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});
