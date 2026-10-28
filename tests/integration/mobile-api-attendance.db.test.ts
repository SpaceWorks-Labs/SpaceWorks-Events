import { randomUUID } from "node:crypto";
import { EventPermission, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Attendance confirmation through the mobile API (docs/ATTENDANCE.md,
 * docs/MOBILE_API.md): an attendee reads and answers their own question with
 * the bearer session (the /attend token is never needed or returned), the
 * same release rules apply, owners and admins see reply counts and can share
 * a guest's link, and nobody else can.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.1.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { hashAttendanceToken } from "@/lib/attendanceToken";
import { createEvent, createUser, get, params, post, signIn, type SignedIn } from "../helpers/mobileApi";
import { GET as myAttendance, POST as answer } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/attendance/route";
import { POST as shareLink } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/attendance-link/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const email = (name: string) => `${name}-${suffix}@example.test`;
const orgSlug = `mob-att-${suffix}`;
const ids = { org: "", otherOrg: "", event: "", owner: "", door: "", guest: "", other: "", guestRsvp: "", otherRsvp: "", leaverRsvp: "", leaver: "" };
let owner: SignedIn;
let door: SignedIn;
let guest: SignedIn;
let other: SignedIn;
let leaver: SignedIn;
const at = () => params({ orgSlug, eventId: ids.event });
const atGuest = (rsvpId: string) => params({ orgSlug, eventId: ids.event, rsvpId });
const mine = (rsvpId: string) => params({ rsvpId });

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: "Attendance mobile", slug: orgSlug } })).id;
  ids.otherOrg = (await prisma.organisation.create({ data: { name: "Other attendance", slug: `mob-att-other-${suffix}` } })).id;
  ids.event = await createEvent(ids.org, `att-${suffix}`, { capacity: 2, attendanceCheckReleaseOnDecline: true });
  for (const name of ["owner", "door", "guest", "other", "leaver"] as const) ids[name] = await createUser(email(name), name);
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: ids.org, role: "OWNER" } });
  await prisma.membership.create({ data: { userId: ids.other, organisationId: ids.otherOrg, role: "OWNER" } });
  await prisma.eventCollaborator.create({ data: { userId: ids.door, eventId: ids.event, permissions: Object.values(EventPermission) } });
  const rsvp = (userId: string) => prisma.rSVP.create({ data: { eventId: ids.event, userId, attendeeKey: `user:${userId}`, status: RsvpStatus.CONFIRMED } });
  ids.guestRsvp = (await rsvp(ids.guest)).id;
  ids.leaverRsvp = (await rsvp(ids.leaver)).id;
  await prisma.rSVP.create({ data: { eventId: ids.event, attendeeKey: `guest:${email("waiting")}`, guestEmail: email("waiting"), status: RsvpStatus.WAITLISTED } });
  [owner, door, guest, other, leaver] = await Promise.all(["owner", "door", "guest", "other", "leaver"].map((name) => signIn(email(name))));
});

afterAll(async () => {
  await prisma.outboxMessage.deleteMany({ where: { payload: { path: ["to"], string_contains: suffix } } });
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.org, ids.otherOrg] } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } });
});

describe.sequential("attendance confirmation through the mobile API", () => {
  it("shows nothing before the guest is asked, and counts nothing", async () => {
    const before = await (await myAttendance(get("/x", guest.accessToken), mine(ids.guestRsvp))).json();
    expect(before).toEqual({ ok: true, data: { attendance: null } });
    expect((await answer(post("/x", { response: "ATTENDING" }, guest.accessToken), mine(ids.guestRsvp))).status).toBe(404);
    const detail = await (await eventDetail(get("/x", owner.accessToken), at())).json();
    expect(detail.data.counts.attendance).toBeNull();
  });

  it("lets the guest read and answer their own question, never seeing the link", async () => {
    expect(await sendAttendanceChecksForUser(ids.owner, { organisationSlug: orgSlug, eventId: ids.event })).toEqual({ ok: true, data: { queued: 2 } });
    const read = await myAttendance(get("/x", guest.accessToken), mine(ids.guestRsvp));
    const body = await read.json();
    expect(body).toEqual({ ok: true, data: { attendance: { response: null, respondedAt: null, note: "", closed: null, releaseKind: "free", releaseRefund: null } } });
    const check = await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: ids.guestRsvp } });
    expect(JSON.stringify(body)).not.toContain(check.tokenHash);

    const yes = await answer(post("/x", { response: "ATTENDING", note: "Arriving late" }, guest.accessToken), mine(ids.guestRsvp));
    expect(await yes.json()).toEqual({ ok: true, data: { response: "ATTENDING", released: false, releaseFailed: null } });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: ids.guestRsvp } })).toMatchObject({ response: "ATTENDING", note: "Arriving late", tokenHash: check.tokenHash });
    const invalid = await answer(post("/x", { response: "MAYBE" }, guest.accessToken), mine(ids.guestRsvp));
    expect(invalid.status).toBe(400);
  });

  it("never reaches someone else's registration", async () => {
    expect((await myAttendance(get("/x", other.accessToken), mine(ids.guestRsvp))).status).toBe(404);
    expect((await answer(post("/x", { response: "NOT_ATTENDING" }, other.accessToken), mine(ids.guestRsvp))).status).toBe(404);
    expect((await myAttendance(get("/x"), mine(ids.guestRsvp))).status).toBe(401);
    expect((await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: ids.guestRsvp } })).response).toBe("ATTENDING");
  });

  it("releases a free place on No, as the web form does", async () => {
    const no = await answer(post("/x", { response: "NOT_ATTENDING" }, leaver.accessToken), mine(ids.leaverRsvp));
    expect(await no.json()).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true, releaseFailed: null } });
    expect(await prisma.rSVP.findUnique({ where: { id: ids.leaverRsvp } })).toBeNull();
    expect(await prisma.rSVP.count({ where: { eventId: ids.event, status: RsvpStatus.CONFIRMED } })).toBe(2);
  });

  it("gives owners and admins the reply counts, and nobody else", async () => {
    const detail = await (await eventDetail(get("/x", owner.accessToken), at())).json();
    expect(detail.data.counts.attendance).toEqual({ coming: 1, notComing: 0, noReply: 0, notAsked: 1 });
    // A co-organiser with every grant sees guests but not the attendance line (sendEmails is admin-only).
    const collaborator = await (await eventDetail(get("/x", door.accessToken), at())).json();
    expect(collaborator.data.counts).not.toBeNull();
    expect(collaborator.data.counts.attendance).toBeNull();
  });

  it("shares a guest's link for owners and admins only, without exposing anything stored", async () => {
    const promoted = await prisma.rSVP.findFirstOrThrow({ where: { eventId: ids.event, status: RsvpStatus.CONFIRMED, userId: null } });
    const shared = await shareLink(post("/x", {}, owner.accessToken), atGuest(promoted.id));
    const body = await shared.json();
    expect(shared.status, JSON.stringify(body)).toBe(200);
    expect(body.data).toMatchObject({ replaced: false, url: expect.stringMatching(/\/attend\/[A-Za-z0-9_-]{43}$/) });
    const raw = body.data.url.split("/attend/")[1];
    expect((await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: promoted.id } })).tokenHash).toBe(hashAttendanceToken(raw));
    expect(await prisma.auditEvent.findFirst({ where: { action: "ATTENDANCE_CHECK_LINK_SHARED", targetId: ids.event } })).toBeTruthy();

    expect((await shareLink(post("/x", {}, door.accessToken), atGuest(promoted.id))).status).toBe(403);
    expect((await shareLink(post("/x", {}, other.accessToken), atGuest(promoted.id))).status).toBe(404);
    const waiting = await prisma.rSVP.create({ data: { eventId: ids.event, attendeeKey: `guest:${email("later")}`, guestEmail: email("later"), status: RsvpStatus.WAITLISTED } });
    expect((await shareLink(post("/x", {}, owner.accessToken), atGuest(waiting.id))).status).toBe(409);
  });
});
