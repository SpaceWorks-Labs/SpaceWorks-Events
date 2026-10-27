import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";
import type { CredentialsConfig } from "next-auth/providers/credentials";

const mocks = vi.hoisted(() => ({ config: null as unknown, find: vi.fn(), accountFind: vi.fn(), compare: vi.fn(), limit: vi.fn(), registrationEnabled: vi.fn(), consume: vi.fn(), recovery: vi.fn() }));
const guard = vi.hoisted(() => ({
  blocked: vi.fn(), failed: vi.fn(), attack: vi.fn(), locked: vi.fn(), known: vi.fn(), send: vi.fn(), consume: vi.fn(), remember: vi.fn(), check: vi.fn(),
}));
vi.mock("@/lib/loginSecurity", () => ({
  isAddressBlocked: guard.blocked, noteFailedSignIn: guard.failed, accountUnderAttack: guard.attack, accountLocked: guard.locked,
  knownDevice: guard.known, sendSignInCode: guard.send, consumeSignInCode: guard.consume, rememberSignIn: guard.remember,
  newDeviceCheckEnabled: guard.check, deviceHash: (id?: string) => (id ? `hash-${id}` : null),
}));
vi.mock("next-auth", () => ({
  default: (factory: unknown) => { mocks.config = factory; return {}; },
  CredentialsSignin: class extends Error {},
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.find }, account: { findUnique: mocks.accountFind } } }));
vi.mock("bcryptjs", () => ({ default: { compare: mocks.compare } }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.limit }));
vi.mock("@/lib/mfa", () => ({ consumeMfaCode: mocks.consume, consumeRecoveryCode: mocks.recovery, decryptMfaSecret: () => "synthetic-seed" }));
vi.mock("@/lib/instanceSettings", () => ({ getGoogleSsoSettings: async () => null, getMobileGoogleClientIds: async () => [], isNewUserRegistrationEnabled: mocks.registrationEnabled }));
import "@/lib/auth";
import { verifyPasswordSignIn } from "@/lib/credentialsAuth";
let config: NextAuthConfig;
beforeEach(async () => {
  vi.clearAllMocks();
  config = await (mocks.config as () => Promise<NextAuthConfig>)();
  mocks.limit.mockResolvedValue(false);
  mocks.compare.mockResolvedValue(true);
  mocks.find.mockResolvedValue({ id: "user_1", email: "person@example.test", emailVerified: new Date(), passwordHash: "hash", sessionVersion: 2 });
  mocks.accountFind.mockResolvedValue(null);
  mocks.registrationEnabled.mockResolvedValue(true);
  guard.blocked.mockResolvedValue(false);
  guard.attack.mockResolvedValue(false);
  guard.locked.mockResolvedValue(false);
  guard.known.mockResolvedValue({ known: true, firstDevice: false });
  guard.send.mockResolvedValue(true);
  guard.consume.mockResolvedValue(false);
  guard.check.mockReturnValue(true);
});
const jwt = (args: unknown) => config.callbacks!.jwt!(args as Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>>[0]);
const authorize = (raw: Record<string, string>) => {
  const provider = config.providers[0] as CredentialsConfig;
  return provider.authorize(raw, new Request("https://example.test/api/auth/callback/credentials"));
};
const context = { ip: "203.0.113.4", userAgent: "SpaceWorksEvents/1.0 (Android 15)" };
const mfaUser = { id: "user_1", email: "person@example.test", emailVerified: new Date(), passwordHash: "hash", sessionVersion: 2, mfaSecretEncrypted: "enc" };

// The web Credentials provider and the mobile API share verifyPasswordSignIn:
// each refusal the web turns into an Auth.js error code is the same reason here.
async function both(raw: Record<string, string>) {
  const shared = await verifyPasswordSignIn(raw, context);
  let web: string;
  try {
    web = (await authorize(raw)) ? "ok" : "invalid";
  } catch (error) {
    web = (error as { code?: string; }).code ?? "error";
  }
  return { shared: shared.ok ? "ok" : shared.reason, web };
}

describe("shared password sign-in", () => {
  it("gives the web and the app the same outcome in every case", async () => {
    const credentials = { email: "person@example.test", password: "password", device: "a".repeat(32) };
    expect(await both(credentials)).toEqual({ shared: "ok", web: "ok" });

    mocks.compare.mockResolvedValue(false);
    expect(await both(credentials)).toEqual({ shared: "invalid", web: "invalid" });
    mocks.compare.mockResolvedValue(true);

    guard.blocked.mockResolvedValue(true);
    expect(await both(credentials)).toEqual({ shared: "too_many_attempts", web: "too_many_attempts" });
    guard.blocked.mockResolvedValue(false);

    mocks.find.mockResolvedValue({ ...mfaUser, emailVerified: null });
    expect(await both(credentials)).toEqual({ shared: "email_verification_required", web: "email_verification_required" });

    mocks.find.mockResolvedValue(mfaUser);
    expect(await both(credentials)).toEqual({ shared: "mfa_required", web: "mfa_required" });
    mocks.consume.mockResolvedValue(true);
    const verified = await verifyPasswordSignIn({ ...credentials, totp: "123456" }, context);
    expect(verified).toMatchObject({ ok: true, user: { id: "user_1", mfaVerified: true, sessionVersion: 2 } });

    mocks.find.mockResolvedValue({ ...mfaUser, mfaSecretEncrypted: null });
    guard.known.mockResolvedValue({ known: false, firstDevice: false });
    expect(await both(credentials)).toEqual({ shared: "email_code_required", web: "email_code_required" });
    expect(guard.send).toHaveBeenCalled();
    guard.locked.mockResolvedValue(true);
    guard.attack.mockResolvedValue(true);
    expect(await both(credentials)).toEqual({ shared: "too_many_attempts", web: "too_many_attempts" });
  });

  it("remembers the app install as the sign-in device", async () => {
    await verifyPasswordSignIn({ email: "person@example.test", password: "password", device: "b".repeat(64) }, context);
    expect(guard.remember).toHaveBeenCalledWith(expect.objectContaining({ hash: `hash-${"b".repeat(64)}`, ip: context.ip, userAgent: context.userAgent }));
  });
});
