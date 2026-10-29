import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), userFind: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.userFind } } }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { throw new Error(`redirect:${path}`); },
  notFound: () => { throw new Error("not-found"); },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

import { requireSuperAdmin, superAdminEmailFor } from "@/lib/permissions";

const originalEmail = process.env.SUPER_ADMIN_EMAIL;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPER_ADMIN_EMAIL = "admin@example.test";
  mocks.auth.mockResolvedValue({ user: { id: "user_1", email: "stale@example.test" }, authMethod: "credentials" });
  mocks.userFind.mockResolvedValue({ email: "admin@example.test", emailVerified: new Date() });
});

afterEach(() => {
  if (originalEmail === undefined) delete process.env.SUPER_ADMIN_EMAIL;
  else process.env.SUPER_ADMIN_EMAIL = originalEmail;
});

describe("super-admin identity boundary", () => {
  it("authorizes against the current verified database email, not stale session claims", async () => {
    await expect(requireSuperAdmin()).resolves.toMatchObject({
      user: { id: "user_1", email: "admin@example.test" },
    });
    expect(mocks.userFind).toHaveBeenCalledWith({
      where: { id: "user_1" },
      select: { email: true, emailVerified: true },
    });
  });

  it("rejects a stale session after the database email no longer matches", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "user_1", email: "admin@example.test" }, authMethod: "credentials" });
    mocks.userFind.mockResolvedValue({ email: "former-admin@example.test", emailVerified: new Date() });
    await expect(requireSuperAdmin()).rejects.toThrow("not-found");
  });

  it("rejects an unverified current account", async () => {
    mocks.userFind.mockResolvedValue({ email: "admin@example.test", emailVerified: null });
    await expect(requireSuperAdmin()).rejects.toThrow("not-found");
  });

  it.each([
    ["a Google sign-in", { authMethod: "google" as const }],
    ["a session from before sign-in methods were recorded", {}],
  ])("refuses %s, even for the super admin's own account", async (_label, extra) => {
    mocks.auth.mockResolvedValue({ user: { id: "user_1", email: "admin@example.test" }, ...extra });
    await expect(requireSuperAdmin()).rejects.toThrow("not-found");
    await expect(superAdminEmailFor({ user: { id: "user_1" }, ...extra })).resolves.toBeNull();
    expect(mocks.userFind).not.toHaveBeenCalled();
  });
});
