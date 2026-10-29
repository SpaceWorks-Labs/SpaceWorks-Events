import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  findUser: vi.fn(),
  findMembership: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.session }));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: mocks.findUser }, membership: { findFirst: mocks.findMembership } },
}));
// React's request cache is a no-op outside a server render; call through.
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

import { loadHelpAccess } from "@/lib/views/app__help__layout";
import { helpAccessForViewer } from "@/lib/help/access";
import { findHelpArticle, helpSearchDocuments, visibleHelpSections } from "@/lib/help/content";
import { pageSecurity } from "@/lib/pageSecurity";
import { GET } from "@/app/api/help/search-index/route";

const access = (...levels: Array<"public" | "org-admin" | "super-admin">) => new Set(levels);
const restricted = (slug: string) => /^(developers|instance|installation)\//.test(slug);

describe("guide access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SUPER_ADMIN_EMAIL", "root@example.org");
    mocks.findUser.mockResolvedValue({ email: "someone@example.org", emailVerified: new Date() });
    mocks.findMembership.mockResolvedValue(null);
  });

  it("gives signed-out visitors the public sections only", async () => {
    mocks.session.mockResolvedValue(null);
    expect(await loadHelpAccess()).toEqual(["public"]);
    expect(mocks.findUser).not.toHaveBeenCalled();
  });

  it("adds developer sections for organisation owners and admins", async () => {
    mocks.session.mockResolvedValue({ user: { id: "user_1" } });
    mocks.findMembership.mockResolvedValue({ id: "membership_1" });
    expect([...(await helpAccessForViewer())].sort()).toEqual(["org-admin", "public"]);
    expect(mocks.findMembership).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user_1", role: { in: ["OWNER", "ADMIN"] } } }));
  });

  it("keeps plain members and attendees on the public sections", async () => {
    mocks.session.mockResolvedValue({ user: { id: "user_1" } });
    expect(await loadHelpAccess()).toEqual(["public"]);
  });

  it("opens everything to the verified super admin, and nothing extra when unverified", async () => {
    mocks.session.mockResolvedValue({ user: { id: "root" }, authMethod: "credentials" });
    mocks.findUser.mockResolvedValue({ email: "Root@Example.org", emailVerified: new Date() });
    expect((await loadHelpAccess()).sort()).toEqual(["org-admin", "public", "super-admin"]);

    mocks.findUser.mockResolvedValue({ email: "root@example.org", emailVerified: null });
    expect(await loadHelpAccess()).toEqual(["public"]);
  });

  it("opens nothing extra to the super admin's account signed in without the password", async () => {
    mocks.session.mockResolvedValue({ user: { id: "root" }, authMethod: "google" });
    mocks.findUser.mockResolvedValue({ email: "root@example.org", emailVerified: new Date() });
    expect(await loadHelpAccess()).toEqual(["public"]);
  });

  it("opens nothing extra when no super admin is configured", async () => {
    vi.stubEnv("SUPER_ADMIN_EMAIL", "");
    mocks.session.mockResolvedValue({ user: { id: "root" }, authMethod: "credentials" });
    mocks.findUser.mockResolvedValue({ email: "root@example.org", emailVerified: new Date() });
    expect(await loadHelpAccess()).toEqual(["public"]);
  });

  it("hides restricted articles and sections from viewers without access", () => {
    expect(findHelpArticle("instance/settings", access("public"))).toBeNull();
    expect(findHelpArticle("installation/vps-install", access("public", "org-admin"))).toBeNull();
    expect(findHelpArticle("developers/api", access("public"))).toBeNull();
    expect(findHelpArticle("developers/api", access("public", "org-admin"))?.title).toBe("The machine API");
    expect(findHelpArticle("installation/vps-install", access("public", "org-admin", "super-admin"))).not.toBeNull();
    expect(findHelpArticle("../../package", access("public", "org-admin", "super-admin"))).toBeNull();
    expect(visibleHelpSections(access("public")).map((section) => section.access)).toEqual(expect.not.arrayContaining(["org-admin", "super-admin"]));
  });

  it("indexes only readable articles for search", () => {
    const publicDocs = helpSearchDocuments(access("public"));
    expect(publicDocs.some((doc) => restricted(doc.slug))).toBe(false);
    expect(publicDocs.every((doc) => doc.sections.length > 0)).toBe(true);
    const adminDocs = helpSearchDocuments(access("public", "org-admin", "super-admin"));
    expect(adminDocs.some((doc) => doc.slug === "instance/settings")).toBe(true);
  });

  it("serves the search index privately and without restricted sections to guests", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = (await response.json()) as { documents: Array<{ slug: string }> };
    expect(body.documents.length).toBeGreaterThan(50);
    expect(body.documents.some((doc) => restricted(doc.slug))).toBe(false);
  });
});

describe("guide page caching", () => {
  it("lets signed-out guide pages be cached but never a signed-in one", () => {
    const signedOut = pageSecurity(new NextRequest("https://events.example.org/help/events/publishing"));
    expect(signedOut.headers.get("Cache-Control")).toBe("no-transform");
    const signedIn = pageSecurity(new NextRequest("https://events.example.org/help/developers/api", { headers: { cookie: "__Secure-swe.session-token.v1=x" } }));
    expect(signedIn.headers.get("Cache-Control")).toContain("no-store");
  });
});
