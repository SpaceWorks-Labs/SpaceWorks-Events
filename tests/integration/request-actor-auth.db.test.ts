import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Auth.js itself can't load under Vitest; the cookie session is "nobody".
vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { hasRecentAuthentication } from "@/lib/reauth";
import { runAsRequestActor } from "@/lib/requestActor";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
let userId = "";

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", "integration-auth-secret-with-at-least-32-characters");
  userId = (await prisma.user.create({ data: { name: "Actor", email: `actor-${suffix}@example.test`, emailVerified: new Date() } })).id;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("auth() inside a mobile request", () => {
  it("presents the app session, with its own freshness and authenticator check", async () => {
    const actor = { kind: "mobile" as const, userId, sessionId: "s", mfaVerifiedAt: new Date(), authenticatedAt: new Date() };
    await runAsRequestActor(actor, async () => {
      const session = await auth();
      expect(session?.user).toMatchObject({ id: userId, email: `actor-${suffix}@example.test` });
      expect((session as { mfaVerified?: boolean; }).mfaVerified).toBe(true);
      expect(await hasRecentAuthentication()).toBe(true);
    });
    await runAsRequestActor({ ...actor, mfaVerifiedAt: null, authenticatedAt: new Date(Date.now() - 11 * 60_000) }, async () => {
      expect((await auth() as { mfaVerified?: boolean; }).mfaVerified).toBe(false);
      expect(await hasRecentAuthentication()).toBe(false);
    });
  });

  it("falls back to the cookie session outside an actor", async () => {
    expect(await auth()).toBeNull();
  });

  it("has no session for a deleted user", async () => {
    await runAsRequestActor({ kind: "mobile", userId: "missing-user", sessionId: "s", mfaVerifiedAt: null, authenticatedAt: new Date() }, async () => {
      expect(await auth()).toBeNull();
    });
  });
});
