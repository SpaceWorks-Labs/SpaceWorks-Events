import { randomUUID } from "node:crypto";
import { EventPermission, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/* Event crew through the mobile API (docs/CREW.md): free tickets outside capacity, managed by MANAGE_REGISTRATIONS. */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.0.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { createEvent, createUser, del, get, none, params, post, signIn, type SignedIn } from "../helpers/mobileApi";
import { GET as crewList, POST as addCrew } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/crew/route";
import { DELETE as removeCrew } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/crew/[memberId]/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";
import { GET as guestList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/route";
import { GET as myRegistrations } from "@/app/api/mobile/v1/me/registrations/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const ids = { org: "", otherOrg: "", event: "", otherEvent: "", owner: "", door: "", crewUser: "" };
const orgSlug = `mob-crew-${suffix}`;
let owner: SignedIn;
let door: SignedIn;
const at = () => params({ orgSlug, eventId: ids.event });

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Crew mobile", slug: orgSlug } })).id;
  ids.otherOrg = (await prisma.organisation.create({ data: { name: "Other crew", slug: `mob-crew-other-${suffix}` } })).id;
  ids.event = await createEvent(ids.org, `crew-${suffix}`, { capacity: 5 });
  ids.otherEvent = await createEvent(ids.otherOrg, `crew-other-${suffix}`);
  ids.owner = await createUser(email("owner"), "Owner");
  ids.door = await createUser(email("door"), "Door");
  ids.crewUser = await createUser(email("crewmate"), "Crew Mate");
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: ids.org, role: "OWNER" } });
  await prisma.eventCollaborator.create({ data: { userId: ids.door, eventId: ids.event, permissions: [EventPermission.CHECK_IN] } });
  await prisma.rSVP.create({ data: { eventId: ids.event, attendeeKey: `guest:${email("guest")}`, guestEmail: email("guest"), guestName: "Guest", status: RsvpStatus.CONFIRMED } });
  owner = await signIn(email("owner"));
  door = await signIn(email("door"));
});

afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.door, ids.crewUser] } } });
});

describe.sequential("event crew through the mobile API", () => {
  it("adds crew with free tickets that never take a place", async () => {
    const added = await addCrew(post("/x", { name: "Crew Mate", email: email("crewmate"), role: "Stage" }, owner.accessToken), at());
    const body = await added.json();
    expect(added.status, JSON.stringify(body)).toBe(201);
    expect(body.data.members).toEqual([expect.objectContaining({ name: "Crew Mate", email: email("crewmate"), role: "Stage", checkedInAt: null })]);
    const ticket = await prisma.rSVP.findFirstOrThrow({ where: { eventId: ids.event, isCrew: true } });
    expect(ticket.status).toBe(RsvpStatus.CONFIRMED);

    const detail = await (await eventDetail(get("/x", owner.accessToken), at())).json();
    expect(detail.data.counts).toMatchObject({ confirmed: 2, crew: 1, capacityUsed: 1 });
    expect(detail.data.myPermissions.manageCrew).toBe(true);
    const guests = await (await guestList(get("/x", owner.accessToken), at())).json();
    expect(guests.data.guests.find((guest: { rsvpId: string; }) => guest.rsvpId === ticket.id)).toMatchObject({ isCrew: true });
    expect(guests.data.guests.filter((guest: { isCrew?: boolean; }) => guest.isCrew)).toHaveLength(1);
  });

  it("shows a crew member their own crew ticket", async () => {
    await prisma.rSVP.updateMany({ where: { eventId: ids.event, isCrew: true }, data: { userId: ids.crewUser, attendeeKey: `user:${ids.crewUser}` } });
    const crewmate = await signIn(email("crewmate"));
    const mine = await (await myRegistrations(get("/x", crewmate.accessToken), none)).json();
    expect(mine.data.upcoming).toEqual([expect.objectContaining({ isCrew: true, status: "CONFIRMED", orderId: null })]);
  });

  it("keeps the crew to MANAGE_REGISTRATIONS and the event's own organisation", async () => {
    expect((await crewList(get("/x", door.accessToken), at())).status).toBe(403);
    expect((await addCrew(post("/x", { name: "Sneaky", email: email("sneaky") }, door.accessToken), at())).status).toBe(403);
    expect((await crewList(get("/x", owner.accessToken), params({ orgSlug: `mob-crew-other-${suffix}`, eventId: ids.otherEvent }))).status).toBe(404);
    expect((await crewList(get("/x", owner.accessToken), params({ orgSlug, eventId: ids.otherEvent }))).status).toBe(404);
  });

  it("removes a crew member and their ticket", async () => {
    const member = await prisma.eventCrewMember.findFirstOrThrow({ where: { eventId: ids.event } });
    expect((await removeCrew(del("/x", owner.accessToken), params({ orgSlug, eventId: ids.event, memberId: member.id }))).status).toBe(200);
    await expect(prisma.rSVP.count({ where: { eventId: ids.event, isCrew: true } })).resolves.toBe(0);
    const list = await (await crewList(get("/x", owner.accessToken), at())).json();
    expect(list.data.members).toEqual([]);
  });
});
