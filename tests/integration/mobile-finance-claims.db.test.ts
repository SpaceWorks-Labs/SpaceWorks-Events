import { randomUUID } from "node:crypto";
import { EventPermission, ExpenseClaimKind, ExpenseClaimStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Staff expense claims through the mobile API (docs/FINANCE.md): members and
 * any event collaborator, the isolated JUDGE, MENTOR and REVIEW_APPLICATIONS
 * grants included, file and withdraw their own claims on that event only,
 * with an Idempotency-Key; deciding stays with owners and admins.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.3.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { BASE, createEvent, createUser, get, newKey, params, post, signIn, type SignedIn } from "../helpers/mobileApi";
import { GET as allClaims, POST as fileClaim } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/finance/claims/route";
import { GET as myClaims } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/finance/claims/mine/route";
import { POST as withdraw } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/finance/claims/[claimId]/withdraw/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const orgSlug = `mob-claims-${suffix}`;
const ids = { org: "", event: "", otherEvent: "" };
const grants = { judge: EventPermission.JUDGE, mentor: EventPermission.MENTOR, reviewer: EventPermission.REVIEW_APPLICATIONS } as const;
const sessions: Partial<Record<keyof typeof grants, SignedIn>> = {};
const users: string[] = [];

function claimForm(token: string, eventId: string, key = newKey()) {
  const form = new FormData();
  form.set("category", "TRAVEL");
  form.set("description", "Train to the venue");
  form.set("amount", "120");
  return new Request(`${BASE}/api/mobile/v1/orgs/${orgSlug}/events/${eventId}/finance/claims`, { method: "POST", headers: { authorization: `Bearer ${token}`, "idempotency-key": key }, body: form });
}

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Claims mobile", slug: orgSlug } })).id;
  ids.event = await createEvent(ids.org, `claims-${suffix}`, { currency: "INR" });
  ids.otherEvent = await createEvent(ids.org, `claims-other-${suffix}`, { currency: "INR" });
  for (const [name, permission] of Object.entries(grants) as Array<[keyof typeof grants, EventPermission]>) {
    const userId = await createUser(email(name), name);
    users.push(userId);
    await prisma.eventCollaborator.create({ data: { userId, eventId: ids.event, permissions: [permission] } });
    sessions[name] = await signIn(email(name));
  }
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
});

const at = <T extends Record<string, string>>(eventId: string, extra: T = {} as T) => params({ orgSlug, eventId, ...extra });

describe.sequential("staff claims from isolated grants", () => {
  it("lets every collaborator file and withdraw their own claim on their event, once per key", async () => {
    for (const name of Object.keys(grants) as Array<keyof typeof grants>) {
      const token = sessions[name]!.accessToken;
      const key = newKey();
      const filed = await fileClaim(claimForm(token, ids.event, key), at(ids.event));
      expect(filed.status, await filed.clone().text()).toBe(201);
      // A retried upload (a new multipart boundary) files nothing more.
      const again = await fileClaim(claimForm(token, ids.event, key), at(ids.event));
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      const claims = await prisma.expenseClaim.findMany({ where: { eventId: ids.event, submittedByUserId: users[Object.keys(grants).indexOf(name)] } });
      expect(claims).toEqual([expect.objectContaining({ kind: ExpenseClaimKind.STAFF, status: ExpenseClaimStatus.SUBMITTED, amountMinor: BigInt(12000) })]);
      expect((await myClaims(get("/x", token), at(ids.event))).status).toBe(200);

      // Not an organiser: every claim and the other event stay out of reach.
      expect((await allClaims(get("/x", token), at(ids.event))).status).toBe(404);
      expect((await fileClaim(claimForm(token, ids.otherEvent), at(ids.otherEvent))).status).toBe(404);
      expect((await withdraw(post("/x", {}, token), at(ids.event, { claimId: claims[0]!.id }))).status).toBe(200);
      expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claims[0]!.id } })).toMatchObject({ status: ExpenseClaimStatus.WITHDRAWN });
    }
  });

  it("never lets one collaborator withdraw another's claim", async () => {
    const filed = await fileClaim(claimForm(sessions.judge!.accessToken, ids.event), at(ids.event));
    expect(filed.status).toBe(201);
    const claim = await prisma.expenseClaim.findFirstOrThrow({ where: { eventId: ids.event, status: ExpenseClaimStatus.SUBMITTED } });
    expect((await withdraw(post("/x", {}, sessions.mentor!.accessToken), at(ids.event, { claimId: claim.id }))).status).not.toBe(200);
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: ExpenseClaimStatus.SUBMITTED });
  });

  it("never withdraws a claim on another event through this event's route", async () => {
    const judgeId = users[Object.keys(grants).indexOf("judge")]!;
    const token = sessions.judge!.accessToken;
    // Filed on the other event while the judge had a grant there; the grant is then removed.
    const grant = await prisma.eventCollaborator.create({ data: { userId: judgeId, eventId: ids.otherEvent, permissions: [EventPermission.JUDGE] } });
    expect((await fileClaim(claimForm(token, ids.otherEvent), at(ids.otherEvent))).status).toBe(201);
    await prisma.eventCollaborator.delete({ where: { id: grant.id } });
    const elsewhere = await prisma.expenseClaim.findFirstOrThrow({ where: { eventId: ids.otherEvent, submittedByUserId: judgeId, status: ExpenseClaimStatus.SUBMITTED } });

    const refused = await withdraw(post("/x", {}, token), at(ids.event, { claimId: elsewhere.id }));
    expect(refused.status).not.toBe(200);
    expect(await prisma.expenseClaim.findUniqueOrThrow({ where: { id: elsewhere.id } })).toMatchObject({ status: ExpenseClaimStatus.SUBMITTED });
  });
});
