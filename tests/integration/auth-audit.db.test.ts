import { randomUUID } from "node:crypto";
import { MembershipRole } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string; }; mfaVerified?: boolean; authMethod?: "credentials" | "google"; } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "198.51.100.30" }),
  cookies: async () => ({ get: () => undefined, getAll: () => [] }),
}));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("not-found"); }, redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { updateOrganisation } from "@/app/actions/org";
import { evaluateGoogleSignIn } from "@/lib/googleSignIn";
import { requireSuperAdmin } from "@/lib/permissions";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const email = (name: string) => `${name}-${suffix}@example.test`;
const users: Record<string, string> = {};
let organisationId = "";
const orgSlug = `audit-auth-${suffix}`;

beforeAll(async () => {
  for (const name of ["admin", "root", "person"]) {
    users[name] = (await prisma.user.create({ data: { name, email: email(name), emailVerified: new Date() } })).id;
  }
  organisationId = (await prisma.organisation.create({ data: { name: "Audit Makers", slug: orgSlug } })).id;
  await prisma.membership.create({ data: { userId: users.admin!, organisationId, role: MembershipRole.ADMIN } });
  // The super admin once linked a Google account, before Google was refused for them.
  await prisma.account.create({ data: { userId: users.root!, type: "oidc", provider: "google", providerAccountId: `google-root-${suffix}` } });
});

beforeEach(() => {
  session.value = null;
  vi.stubEnv("SUPER_ADMIN_EMAIL", email("root"));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

describe("organisation settings and the staff authenticator rule", () => {
  beforeAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "true"));
  afterAll(() => vi.stubEnv("STAFF_MFA_REQUIRED", "false"));

  it("refuses an admin whose session has not passed the authenticator check", async () => {
    await prisma.user.update({ where: { id: users.admin! }, data: { mfaEnabledAt: new Date() } });
    const edit = () => updateOrganisation({ organisationSlug: orgSlug, name: "Renamed Makers", description: "", logoUrl: "" });

    session.value = { user: { id: users.admin! } };
    await expect(edit()).resolves.toEqual({ ok: false, error: "Only organisation admins can edit settings." });
    await expect(prisma.organisation.findUniqueOrThrow({ where: { id: organisationId } })).resolves.toMatchObject({ name: "Audit Makers" });

    session.value = { user: { id: users.admin! }, mfaVerified: true };
    await expect(edit()).resolves.toEqual({ ok: true });
    await expect(prisma.organisation.findUniqueOrThrow({ where: { id: organisationId } })).resolves.toMatchObject({ name: "Renamed Makers" });
  });
});

describe("the super admin and Google", () => {
  it("denies Google for the super admin's address and for a Google account already linked to them", async () => {
    await expect(evaluateGoogleSignIn({ email: email("ROOT"), emailVerified: true, providerAccountId: `google-new-${suffix}` })).resolves.toBe("deny");
    await expect(evaluateGoogleSignIn({ email: email("root-alias"), emailVerified: true, providerAccountId: `google-root-${suffix}` })).resolves.toBe("deny");
    await expect(evaluateGoogleSignIn({ email: email("person"), emailVerified: true, providerAccountId: `google-person-${suffix}` })).resolves.toBe("allow");
  });

  it("opens the super admin area only to a password sign-in", async () => {
    session.value = { user: { id: users.root! }, authMethod: "credentials" };
    await expect(requireSuperAdmin()).resolves.toMatchObject({ user: { id: users.root!, email: email("root") } });
    for (const authMethod of ["google", undefined] as const) {
      session.value = { user: { id: users.root! }, authMethod };
      await expect(requireSuperAdmin()).rejects.toThrow("not-found");
    }
  });
});
