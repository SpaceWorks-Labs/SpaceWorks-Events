import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  audit: vi.fn(),
  revalidatePath: vi.fn(),
  orgFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  membershipFindUnique: vi.fn(),
  membershipCount: vi.fn(),
  membershipDeleteMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.rateLimit }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/db", () => ({
  prisma: {
    organisation: { findUnique: mocks.orgFindUnique },
    $transaction: mocks.transaction,
  },
}));

import { leaveOrganisation } from "@/app/actions/account-organisations";

const tx = {
  $queryRaw: mocks.queryRaw,
  membership: {
    findUnique: mocks.membershipFindUnique,
    count: mocks.membershipCount,
    deleteMany: mocks.membershipDeleteMany,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.rateLimit.mockResolvedValue(false);
  mocks.orgFindUnique.mockResolvedValue({ id: "org_1", slug: "acme" });
  mocks.transaction.mockImplementation((fn: (client: typeof tx) => unknown) => fn(tx));
  mocks.queryRaw.mockResolvedValue([{ id: "org_1" }]);
  mocks.membershipFindUnique.mockResolvedValue({ id: "membership_1", role: "MEMBER" });
  mocks.membershipCount.mockResolvedValue(1);
  mocks.membershipDeleteMany.mockResolvedValue({ count: 1 });
});

describe("leaveOrganisation", () => {
  it("rejects unauthenticated callers before touching the database", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toEqual({ ok: false, error: "You must be signed in." });
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("validates input", async () => {
    await expect(leaveOrganisation({ organisationSlug: "" })).resolves.toMatchObject({ ok: false, error: "Invalid input." });
    await expect(leaveOrganisation(null)).resolves.toMatchObject({ ok: false, error: "Invalid input." });
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
  });

  it("honours the action rate limit for the caller", async () => {
    mocks.rateLimit.mockResolvedValue(true);
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/too many/i) });
    expect(mocks.rateLimit).toHaveBeenCalledWith("action", "user_1");
    expect(mocks.orgFindUnique).not.toHaveBeenCalled();
    expect(mocks.membershipDeleteMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown organisation", async () => {
    mocks.orgFindUnique.mockResolvedValue(null);
    await expect(leaveOrganisation({ organisationSlug: "missing" })).resolves.toEqual({ ok: false, error: "You are not a member of this organisation." });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a non-member without deleting anything", async () => {
    mocks.membershipFindUnique.mockResolvedValue(null);
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toEqual({ ok: false, error: "You are not a member of this organisation." });
    expect(mocks.membershipDeleteMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("blocks the sole owner, checking ownership under the organisation lock", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ id: "membership_1", role: "OWNER" });
    mocks.membershipCount.mockResolvedValue(1);
    const result = await leaveOrganisation({ organisationSlug: "acme" });
    expect(result).toMatchObject({ ok: false, error: "You are the only owner, so you can't leave. Delete the organisation from its settings instead." });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.membershipCount.mock.invocationCallOrder[0]!);
    expect(mocks.membershipCount).toHaveBeenCalledWith({ where: { organisationId: "org_1", role: "OWNER" } });
    expect(mocks.membershipDeleteMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "ADMIN"] as const)("lets a %s leave without counting owners", async (role) => {
    mocks.membershipFindUnique.mockResolvedValue({ id: "membership_1", role });
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toEqual({ ok: true });
    expect(mocks.membershipCount).not.toHaveBeenCalled();
    expect(mocks.membershipDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("lets a co-owner leave when another owner remains", async () => {
    mocks.membershipFindUnique.mockResolvedValue({ id: "membership_1", role: "OWNER" });
    mocks.membershipCount.mockResolvedValue(2);
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toEqual({ ok: true });
    expect(mocks.membershipDeleteMany).toHaveBeenCalledTimes(1);
  });

  it("deletes only the caller's own membership and audits it in the same transaction", async () => {
    await expect(leaveOrganisation({ organisationSlug: " acme " })).resolves.toEqual({ ok: true });
    expect(mocks.orgFindUnique).toHaveBeenCalledWith({ where: { slug: "acme" }, select: { id: true, slug: true } });
    expect(mocks.membershipFindUnique).toHaveBeenCalledWith({
      where: { userId_organisationId: { userId: "user_1", organisationId: "org_1" } },
      select: { id: true, role: true },
    });
    expect(mocks.membershipDeleteMany).toHaveBeenCalledWith({ where: { id: "membership_1", userId: "user_1", organisationId: "org_1" } });
    expect(mocks.audit).toHaveBeenCalledWith({
      action: "ORGANISATION_MEMBER_LEFT",
      actorUserId: "user_1",
      organisationId: "org_1",
      targetType: "membership",
      targetId: "membership_1",
      metadata: { role: "MEMBER" },
      client: tx,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/account/organisations");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/acme");
  });

  it("ignores any extra target identifiers in the input", async () => {
    await leaveOrganisation({ organisationSlug: "acme", targetUserId: "someone_else", userId: "someone_else" });
    expect(mocks.membershipFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_organisationId: { userId: "user_1", organisationId: "org_1" } },
    }));
    expect(mocks.membershipDeleteMany).toHaveBeenCalledWith({ where: expect.objectContaining({ userId: "user_1" }) });
  });

  it("does not audit or revalidate when the row vanished concurrently", async () => {
    mocks.membershipDeleteMany.mockResolvedValue({ count: 0 });
    await expect(leaveOrganisation({ organisationSlug: "acme" })).resolves.toMatchObject({ ok: false });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});
