import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextAuthConfig } from "next-auth";

/*
 * Google SSO is instance-managed at runtime: the Auth.js config callback and
 * the mobile config re-read the settings on each request, so a super-admin
 * change applies on every replica without a restart, and unreadable settings
 * never take password sign-in down.
 */

const mocks = vi.hoisted(() => ({ factory: null as unknown, find: vi.fn(), decrypt: vi.fn((value: string) => `plain:${value}`), log: vi.fn() }));
vi.mock("next-auth", () => ({
  default: (factory: unknown) => { mocks.factory = factory; return {}; },
  CredentialsSignin: class extends Error {},
}));
vi.mock("next-auth/providers/google", () => ({ default: (options: object) => ({ id: "google", ...options }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: object) => options }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("@/lib/db", () => ({ prisma: { instanceSetting: { findUnique: mocks.find } } }));
vi.mock("@/lib/credentialsAuth", () => ({ verifyPasswordSignIn: vi.fn() }));
vi.mock("@/lib/opsAlerts", () => ({ logOpsError: mocks.log }));
vi.mock("@/lib/instanceConfigSecrets", () => ({ decryptInstanceConfigSecret: mocks.decrypt }));

import "@/lib/auth";
import { getMobileGoogleConfig } from "@/lib/googleSignIn";

const config = () => (mocks.factory as () => Promise<NextAuthConfig>)();
const providerIds = async () => (await config()).providers.map((provider) => (provider as { id: string; }).id);
const saved = (clientId: string | null, secret: string | null = clientId ? "enc" : null, mobile: string | null = null) =>
  ({ googleClientId: clientId, googleClientSecretEncrypted: secret, googleMobileClientIds: mobile });

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_MOBILE_CLIENT_IDS"]) vi.stubEnv(name, "");
});

afterEach(() => vi.unstubAllEnvs());

describe("runtime Google SSO settings", () => {
  it("is configured with a per-request config callback", () => {
    expect(typeof mocks.factory).toBe("function");
  });

  it("adds, rotates and removes the Google provider as the settings change", async () => {
    mocks.find.mockResolvedValueOnce(saved(null));
    expect(await providerIds()).toEqual(["credentials"]);

    mocks.find.mockResolvedValueOnce(saved("first.apps.googleusercontent.com", "first"));
    expect((await config()).providers[0]).toMatchObject({ id: "google", clientId: "first.apps.googleusercontent.com", clientSecret: "plain:first" });

    mocks.find.mockResolvedValueOnce(saved("second.apps.googleusercontent.com", "second"));
    expect((await config()).providers[0]).toMatchObject({ clientId: "second.apps.googleusercontent.com", clientSecret: "plain:second" });

    mocks.find.mockResolvedValueOnce(saved(null));
    expect(await providerIds()).toEqual(["credentials"]);
    expect(mocks.find).toHaveBeenCalledTimes(4);
  });

  it("keeps password sign-in and sessions working when the Google settings cannot be read", async () => {
    mocks.find.mockResolvedValueOnce(saved("broken.apps.googleusercontent.com", "enc"));
    mocks.decrypt.mockImplementationOnce(() => { throw new Error("Unsupported state or unable to authenticate data"); });
    expect(await providerIds()).toEqual(["credentials"]);
    expect(mocks.log).toHaveBeenCalledOnce();
    expect(mocks.log.mock.calls[0]?.[1]).toMatchObject({ level: "error", source: "auth" });
  });

  it("enables mobile Google sign-in only while web Google SSO is configured, with the saved app client ids", async () => {
    mocks.find
      .mockResolvedValueOnce(saved("web.apps.googleusercontent.com"))
      .mockResolvedValueOnce({ googleMobileClientIds: "1-android.apps.googleusercontent.com" })
      .mockResolvedValueOnce(saved(null));
    await expect(getMobileGoogleConfig()).resolves.toEqual({ webClientId: "web.apps.googleusercontent.com", mobileClientIds: ["1-android.apps.googleusercontent.com"] });
    await expect(getMobileGoogleConfig()).resolves.toBeNull();
  });
});
