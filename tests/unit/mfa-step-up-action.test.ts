import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rateLimit: vi.fn(),
  userFind: vi.fn(),
  auditCreate: vi.fn(),
  decrypt: vi.fn(),
  verify: vi.fn(),
  createProof: vi.fn(),
  cookieSet: vi.fn(),
  sid: vi.fn(),
}));

vi.mock("@/lib/permissions", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.rateLimit }));
vi.mock("@/lib/db", () => ({ prisma: {
  user: { findUnique: mocks.userFind },
  auditEvent: { create: mocks.auditCreate },
} }));
vi.mock("@/lib/mfa", () => ({
  decryptMfaSecret: mocks.decrypt,
  consumeMfaCode: mocks.verify,
}));
vi.mock("@/lib/mfaProof", () => ({
  createMfaProof: mocks.createProof,
  MFA_PROOF_COOKIE: "mfa-proof",
  MFA_PROOF_MAX_AGE_SECONDS: 43200,
}));
vi.mock("next/headers", () => ({ cookies: vi.fn().mockResolvedValue({ set: mocks.cookieSet }) }));
vi.mock("@/lib/sessionSid", () => ({ currentSessionSid: mocks.sid }));

import { verifyStepUpMfa } from "@/app/actions/mfa-step-up";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAuth.mockResolvedValue({ user: { id: "admin_1", email: "admin@example.test" } });
  mocks.rateLimit.mockResolvedValue(false);
  mocks.userFind.mockResolvedValue({
    email: "admin@example.test",
    mfaSecretEncrypted: "encrypted",
    mfaEnabledAt: new Date(),
    sessionVersion: 4,
  });
  mocks.decrypt.mockReturnValue("SECRET");
  mocks.verify.mockReturnValue(true);
  mocks.createProof.mockReturnValue("signed-proof");
  mocks.sid.mockResolvedValue("sid-a");
});

describe("MFA step-up action", () => {
  it("applies the strict authentication limit before verifying a code", async () => {
    mocks.rateLimit.mockResolvedValue(true);
    await expect(verifyStepUpMfa({ code: "123456" })).resolves.toEqual({
      ok: false,
      error: "Too many attempts. Please try again later.",
    });
    expect(mocks.rateLimit).toHaveBeenCalledWith("auth", "admin_1");
    expect(mocks.userFind).not.toHaveBeenCalled();
  });

  it("sets an HttpOnly proof only after successful TOTP verification", async () => {
    await expect(verifyStepUpMfa({ code: "123456" })).resolves.toEqual({ ok: true });
    expect(mocks.cookieSet).toHaveBeenCalledWith("mfa-proof", "signed-proof", expect.objectContaining({
      httpOnly: true,
      sameSite: "lax",
      maxAge: 43200,
      path: "/",
    }));
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
    expect(mocks.sid).toHaveBeenCalledWith("admin_1");
    expect(mocks.createProof).toHaveBeenCalledWith("admin_1", 4, "sid-a");
  });

  it("issues no proof for a session without a sign-in id, before spending the code", async () => {
    mocks.sid.mockResolvedValue(null);
    await expect(verifyStepUpMfa({ code: "123456" })).resolves.toMatchObject({ ok: false });
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
