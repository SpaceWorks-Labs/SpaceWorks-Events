import { beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import type { NextAuthConfig } from "next-auth";

/*
 * The MFA proof's binding to a sign-in, through real Auth.js session tokens:
 * the jwt callback mints the sign-in id, the token is encrypted as Auth.js
 * writes the cookie (whole or in chunks), and lib/sessionSid.ts reads it back.
 */
const mocks = vi.hoisted(() => ({ config: null as unknown, find: vi.fn(), jar: [] as Array<{ name: string; value: string }> }));
vi.mock("next-auth", () => ({
  default: (factory: unknown) => { mocks.config = factory; return {}; },
  CredentialsSignin: class extends Error {},
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.find } } }));
vi.mock("@/lib/instanceSettings", () => ({ getGoogleSsoSettings: async () => null, isNewUserRegistrationEnabled: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => mocks.jar }) }));

import "@/lib/auth";
import { createMfaProof, hasValidMfaProof } from "@/lib/mfaProof";
import { currentSessionSid, SESSION_COOKIE_NAME, sessionTokenFromCookies } from "@/lib/sessionSid";

const SECRET = "unit-test-auth-secret-with-at-least-32-characters";
let config: NextAuthConfig;
const jwt = (args: unknown) => config.callbacks!.jwt!(args as Parameters<NonNullable<NonNullable<NextAuthConfig["callbacks"]>["jwt"]>>[0]) as Promise<Record<string, unknown> | null>;

/** Store a token in the jar the way Auth.js writes the session cookie. */
async function setSessionCookie(token: Record<string, unknown>, chunks = 1) {
  const value = await encode({ token, secret: SECRET, salt: SESSION_COOKIE_NAME });
  if (chunks === 1) { mocks.jar = [{ name: SESSION_COOKIE_NAME, value }]; return; }
  const size = Math.ceil(value.length / chunks);
  // Out of order on purpose: the reader sorts by chunk index.
  mocks.jar = Array.from({ length: chunks }, (_, index) => ({ name: `${SESSION_COOKIE_NAME}.${index}`, value: value.slice(index * size, (index + 1) * size) })).reverse();
}

beforeEach(async () => {
  vi.stubEnv("AUTH_SECRET", SECRET);
  config = await (mocks.config as () => Promise<NextAuthConfig>)();
  mocks.find.mockResolvedValue({ sessionVersion: 2 });
  mocks.jar = [];
});

describe("sign-in id cookie flow", () => {
  it("keeps one sid across refreshes, and a new sign-in voids the old proof", async () => {
    const signedIn = (await jwt({ token: {}, user: { id: "user_1" }, account: { provider: "google" } }))!;
    await setSessionCookie(signedIn, 3);
    const sid = await currentSessionSid("user_1");
    expect(sid).toBe(signedIn.sid);
    const proof = createMfaProof("user_1", 2, sid!);

    // Ordinary reads re-run the callback on the decoded token; the sid never changes.
    for (let read = 0; read < 3; read += 1) {
      const refreshed = (await jwt({ token: { ...signedIn } }))!;
      await setSessionCookie(refreshed);
      expect(hasValidMfaProof(proof, "user_1", 2, await currentSessionSid("user_1"))).toBe(true);
    }

    const again = (await jwt({ token: {}, user: { id: "user_1" }, account: { provider: "google" } }))!;
    await setSessionCookie(again, 2);
    expect(await currentSessionSid("user_1")).toBe(again.sid);
    expect(hasValidMfaProof(proof, "user_1", 2, await currentSessionSid("user_1"))).toBe(false);
  });

  it("binds the sid to the validated user, and ignores tokens it cannot decode", async () => {
    await setSessionCookie({ sub: "user_2", sid: "someone-else" });
    expect(await currentSessionSid("user_1")).toBeNull();
    mocks.jar = [{ name: SESSION_COOKIE_NAME, value: "not-a-token" }];
    expect(await currentSessionSid("user_1")).toBeNull();
    await setSessionCookie({ sub: "user_1" });
    expect(await currentSessionSid("user_1")).toBeNull();
  });

  it("retires a legacy session cookie without a sid", async () => {
    expect(await jwt({ token: { sub: "user_1", sessionVersion: 2 } })).toBeNull();
  });

  it("reads only the session cookie and its numbered chunks", () => {
    expect(sessionTokenFromCookies([
      { name: `${SESSION_COOKIE_NAME}.1`, value: "b" },
      { name: "other", value: "x" },
      { name: `${SESSION_COOKIE_NAME}.0`, value: "a" },
      { name: `${SESSION_COOKIE_NAME}.x`, value: "y" },
      { name: `${SESSION_COOKIE_NAME}-other`, value: "z" },
    ])).toBe("ab");
    expect(sessionTokenFromCookies([])).toBeNull();
  });
});
