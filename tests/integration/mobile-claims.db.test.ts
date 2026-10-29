import { randomUUID } from "node:crypto";
import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Participant expense claims through the mobile API: a claim filed when its
 * list can't be read back answers with its id (never a 5xx, so a retry with
 * the same key replays rather than filing it twice), and a crew ticket is
 * judged by the event's crew claims switch (docs/CREW.md).
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

const listFails = vi.hoisted(() => ({ next: false }));

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.0.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
vi.mock("@/lib/mobile/attendee", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mobile/attendee")>();
  return {
    ...actual,
    // The read after the claim commits fails once, as a dropped database connection would.
    loadMyParticipantClaims: async (userId: string, rsvpId: string) => {
      if (listFails.next) {
        listFails.next = false;
        throw new Error("connection lost");
      }
      return actual.loadMyParticipantClaims(userId, rsvpId);
    },
  };
});

import { prisma } from "@/lib/db";
import { BASE, createEvent, createUser, get, newKey, params, signIn, type SignedIn } from "../helpers/mobileApi";
import { GET as myClaims, POST as fileClaim } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/claims/route";
import { GET as myReimbursements } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/reimbursements/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const ids = { org: "", event: "", crewEvent: "", participant: "", crewUser: "", rsvp: "", crewRsvp: "" };
let participant: SignedIn;
let crewmate: SignedIn;

/** A multipart claim, as the app files it, under the given Idempotency-Key. */
function claimRequest(rsvpId: string, token: string, key: string) {
  const form = new FormData();
  form.set("category", "TRAVEL");
  form.set("description", "Train to the venue");
  form.set("amount", "120");
  return new Request(`${BASE}/api/mobile/v1/me/registrations/${rsvpId}/claims`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": key, "x-real-ip": "198.51.100.77" },
    body: form,
  });
}

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Claims mobile", slug: `mob-claims-${suffix}` } })).id;
  ids.event = await createEvent(ids.org, `claims-${suffix}`, { participantClaimsEnabled: true });
  ids.crewEvent = await createEvent(ids.org, `claims-crew-${suffix}`);
  ids.participant = await createUser(email("participant"), "Participant");
  ids.crewUser = await createUser(email("crew"), "Crew Mate");
  ids.rsvp = (await prisma.rSVP.create({ data: { eventId: ids.event, userId: ids.participant, attendeeKey: `user:${ids.participant}`, status: RsvpStatus.CONFIRMED } })).id;
  // An account-owned free ticket the organisers turned into a crew ticket (lib/core/crew/members.ts).
  ids.crewRsvp = (await prisma.rSVP.create({ data: { eventId: ids.crewEvent, userId: ids.crewUser, attendeeKey: `user:${ids.crewUser}`, status: RsvpStatus.CONFIRMED, isCrew: true } })).id;
  participant = await signIn(email("participant"));
  crewmate = await signIn(email("crew"));
});

afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: ids.org } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.participant, ids.crewUser] } } });
});

describe.sequential("expense claims through the mobile API", () => {
  it("answers a filed claim's id when its list can't be read back, and a retry replays it rather than filing again", async () => {
    const key = newKey();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    listFails.next = true;
    let first: Response;
    try {
      first = await fileClaim(claimRequest(ids.rsvp, participant.accessToken, key), params({ rsvpId: ids.rsvp }));
    } finally {
      error.mockRestore();
    }
    const body = await first.json();
    expect(first.status, JSON.stringify(body)).toBe(201);
    const claims = await prisma.expenseClaim.findMany({ where: { rsvpId: ids.rsvp }, select: { id: true } });
    expect(claims).toHaveLength(1);
    expect(body).toEqual({ ok: true, data: { claimId: claims[0]!.id } });

    const retried = await fileClaim(claimRequest(ids.rsvp, participant.accessToken, key), params({ rsvpId: ids.rsvp }));
    expect(retried.status).toBe(201);
    expect(retried.headers.get("idempotent-replayed")).toBe("true");
    await expect(retried.json()).resolves.toEqual(body);
    await expect(prisma.expenseClaim.count({ where: { rsvpId: ids.rsvp } })).resolves.toBe(1);

    // The list reads normally again.
    const list = await (await myClaims(get("/x", participant.accessToken), params({ rsvpId: ids.rsvp }))).json();
    expect(list.data.claims).toEqual([expect.objectContaining({ id: claims[0]!.id, status: "SUBMITTED" })]);
  });

  it("answers the claim list when it reads back", async () => {
    const filed = await fileClaim(claimRequest(ids.rsvp, participant.accessToken, newKey()), params({ rsvpId: ids.rsvp }));
    expect(filed.status).toBe(201);
    await expect(filed.json()).resolves.toMatchObject({ ok: true, data: { general: true, claims: [expect.anything(), expect.anything()] } });
  });

  it("judges a crew ticket by the crew claims switch, not the participant one", async () => {
    const at = params({ rsvpId: ids.crewRsvp });
    await prisma.event.update({ where: { id: ids.crewEvent }, data: { crewClaimsEnabled: true, participantClaimsEnabled: false } });
    const open = await (await myClaims(get("/x", crewmate.accessToken), at)).json();
    expect(open.data).toMatchObject({ general: true, cap: null, claims: [] });
    await expect((await myReimbursements(get("/x", crewmate.accessToken), at)).json()).resolves.toMatchObject({ data: { general: { cap: null } } });

    await prisma.event.update({ where: { id: ids.crewEvent }, data: { crewClaimsEnabled: false, participantClaimsEnabled: true } });
    await expect((await myClaims(get("/x", crewmate.accessToken), at)).json()).resolves.toEqual({ ok: true, data: null });
    await expect((await myReimbursements(get("/x", crewmate.accessToken), at)).json()).resolves.toEqual({ ok: true, data: null });
  });
});
