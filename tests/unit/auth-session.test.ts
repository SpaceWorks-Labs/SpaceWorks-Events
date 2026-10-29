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
vi.mock("@/lib/instanceSettings", () => ({ getGoogleSsoSettings: async () => null, isNewUserRegistrationEnabled: mocks.registrationEnabled }));
import "@/lib/auth";
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
describe("authentication boundary", () => {
  it("limits the normalized account before reading or hashing", async () => {
    mocks.limit.mockResolvedValue(true);
    expect(await authorize({ email: " PERSON@example.test ", password: "password" })).toBeNull();
    expect(mocks.limit).toHaveBeenCalledWith("auth", "person@example.test");
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.compare).not.toHaveBeenCalled();
  });
  it("performs dummy password work for missing identities", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await authorize({ email: "person@example.test", password: "password" })).toBeNull();
    expect(mocks.compare).toHaveBeenCalledOnce();
  });
  it("rejects oversized credentials before expensive work", async () => {
    expect(await authorize({ email: "person@example.test", password: "a".repeat(129) })).toBeNull();
    expect(mocks.find).not.toHaveBeenCalled();
  });
  it("binds successful password proof to its session version", async () => {
    expect(await authorize({ email: "person@example.test", password: "password" })).toMatchObject({ id: "user_1", sessionVersion: 2 });
  });
  it("rejects a login racing credential revocation", async () => {
    expect(await jwt({ token: {}, user: { id: "user_1", sessionVersion: 1 } })).toBeNull();
  });
  it.each([{}, { sessionVersion: 1 }, { sessionVersion: 2, sessionRevoked: true }])("clears stale sessions %j", async (token) => {
    expect(await jwt({ token: { sub: "user_1", ...token } })).toBeNull();
  });
  it("does not let session updates renew authentication freshness", async () => {
    const token = { sub: "user_1", sessionVersion: 2, authenticatedAt: 123, sid: "sid-a" };
    expect(await jwt({ token, trigger: "update", session: { authenticatedAt: Date.now(), sessionVersion: 99 } })).toEqual(token);
  });
  it("retires a token from before sign-in ids, like a revoked one", async () => {
    expect(await jwt({ token: { sub: "user_1", sessionVersion: 2, authenticatedAt: 123 } })).toBeNull();
  });
  it("records the sign-in method and a fresh sign-in id, and keeps both on refresh", async () => {
    const first = await jwt({ token: {}, user: { id: "user_1", sessionVersion: 2 }, account: { provider: "credentials" } }) as Record<string, unknown>;
    expect(first).toMatchObject({ authMethod: "credentials", sid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/) });
    expect(await jwt({ token: { ...first } })).toMatchObject({ sid: first.sid, authMethod: "credentials" });
    const google = await jwt({ token: {}, user: { id: "user_1" }, account: { provider: "google" } }) as Record<string, unknown>;
    expect(google.authMethod).toBe("google");
    expect(google.sid).not.toBe(first.sid);
  });
  it("puts the sign-in method on the session but never the sign-in id", async () => {
    const session = await config.callbacks!.session!({ session: { user: {}, expires: "" }, token: { sub: "user_1", sid: "sid-a", authMethod: "credentials" } } as never) as unknown as Record<string, unknown>;
    expect(session).toMatchObject({ user: { id: "user_1" }, authMethod: "credentials" });
    expect(JSON.stringify(session)).not.toContain("sid-a");
  });
  it("clears deleted users", async () => {
    mocks.find.mockResolvedValue(null);
    expect(await jwt({ token: { sub: "user_1", sessionVersion: 2 } })).toBeNull();
  });
  it("rejects linking Google to an unverified pre-registered password", async () => {
    mocks.find.mockResolvedValue({ passwordHash: "attacker-hash", emailVerified: null });
    const callback = config.callbacks!.signIn!;
    expect(await callback({ user: { email: "person@example.test" }, account: { provider: "google" }, profile: { email_verified: true } } as Parameters<typeof callback>[0])).toBe(false);
  });

  it("refuses Google for the super admin's address, and for a Google account linked to the super admin", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAIL", "admin@example.test");
    const callback = config.callbacks!.signIn!;
    const attempt = (email: string) => callback({ user: { email }, account: { provider: "google", providerAccountId: "google-user" }, profile: { email_verified: true } } as Parameters<typeof callback>[0]);
    await expect(attempt("ADMIN@example.test")).resolves.toBe(false);
    mocks.accountFind.mockResolvedValue({ id: "account_1", user: { email: "admin@example.test" } });
    await expect(attempt("renamed-in-google@example.test")).resolves.toBe(false);
    mocks.accountFind.mockResolvedValue({ id: "account_1", user: { email: "person@example.test" } });
    await expect(attempt("person@example.test")).resolves.toBe(true);
    vi.unstubAllEnvs();
  });

  it("creates an account for a verified new Google identity when registration is enabled", async () => {
    mocks.find.mockResolvedValue(null);
    const callback = config.callbacks!.signIn!;
    await expect(callback({
      user: { email: "new-person@example.test" },
      account: { provider: "google", providerAccountId: "google-user" },
      profile: { email_verified: true },
    } as Parameters<typeof callback>[0])).resolves.toBe(true);
  });

  it("does not send a new Google identity to signup when account creation is disabled", async () => {
    mocks.find.mockResolvedValue(null);
    mocks.registrationEnabled.mockResolvedValue(false);
    const callback = config.callbacks!.signIn!;
    await expect(callback({
      user: { email: "new-person@example.test" },
      account: { provider: "google", providerAccountId: "google-user" },
      profile: { email_verified: true },
    } as Parameters<typeof callback>[0])).resolves.toBe("/login?error=account_creation_disabled");
  });
});

describe("sign-in protections", () => {
  const rejectsWith = async (raw: Record<string, string>, code: string) => {
    await expect(authorize(raw)).rejects.toMatchObject({ code });
  };

  it("blocks an address with too many recent failures before any password work", async () => {
    guard.blocked.mockResolvedValue(true);
    await rejectsWith({ email: "person@example.test", password: "password" }, "too_many_attempts");
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("counts a wrong password against the address and the account", async () => {
    mocks.compare.mockResolvedValue(false);
    expect(await authorize({ email: "person@example.test", password: "wrong" })).toBeNull();
    expect(guard.failed).toHaveBeenCalledWith("unknown", "person@example.test");
  });

  it("emails a code for a device the account hasn't used, then signs in with it", async () => {
    guard.known.mockResolvedValue({ known: false, firstDevice: false });
    await rejectsWith({ email: "person@example.test", password: "password", device: "a".repeat(64) }, "email_code_required");
    expect(guard.send).toHaveBeenCalledWith({ id: "user_1", email: "person@example.test" });
    expect(guard.remember).not.toHaveBeenCalled();

    expect(await authorize({ email: "person@example.test", password: "password", device: "a".repeat(64), emailCode: "000000" })).toBeNull();
    guard.consume.mockResolvedValue(true);
    expect(await authorize({ email: "person@example.test", password: "password", device: "a".repeat(64), emailCode: "123456" })).toMatchObject({ id: "user_1", mfaVerified: false });
    expect(guard.remember).toHaveBeenCalledWith(expect.objectContaining({ userId: "user_1", hash: `hash-${"a".repeat(64)}`, firstDevice: false }));
  });

  it("trusts an account's very first device, and asks for a code after repeated failures even on a known one", async () => {
    guard.known.mockResolvedValue({ known: false, firstDevice: true });
    expect(await authorize({ email: "person@example.test", password: "password" })).toMatchObject({ id: "user_1" });
    guard.known.mockResolvedValue({ known: true, firstDevice: false });
    guard.attack.mockResolvedValue(true);
    await rejectsWith({ email: "person@example.test", password: "password" }, "email_code_required");
  });

  it("takes an authenticator code instead of an emailed one, and marks the session as verified", async () => {
    mocks.find.mockResolvedValue({ id: "user_1", email: "person@example.test", emailVerified: new Date(), passwordHash: "hash", sessionVersion: 2, mfaSecretEncrypted: "sealed" });
    mocks.consume.mockResolvedValue(true);
    guard.known.mockResolvedValue({ known: false, firstDevice: false });
    expect(await authorize({ email: "person@example.test", password: "password", totp: "123456" })).toMatchObject({ id: "user_1", mfaVerified: true });
    expect(guard.send).not.toHaveBeenCalled();
    expect(await jwt({ token: {}, user: { id: "user_1", sessionVersion: 2, mfaVerified: true } })).toMatchObject({ mfaVerified: true });
  });
});

