import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPermission, RsvpStatus } from "@prisma/client";

// Never let an ambient Redis or base URL leak into this suite.
process.env.REDIS_URL = "";
process.env.NEXT_PUBLIC_BASE_URL = "https://events.example.test";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

const published = vi.hoisted(() => vi.fn());
// Auth.js can't load under Vitest; the real lib/auth.ts presents the app
// session to action bodies, and `web.session` stands in for a browser cookie.
const web = vi.hoisted(() => ({ session: null as null | { user: { id: string; }; } }));
vi.mock("next-auth", () => ({ default: () => ({ auth: async () => web.session, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.51.100.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));
vi.mock("@/lib/ticketCheckInEvents", () => ({ publishTicketCheckedIn: published }));

import { prisma } from "@/lib/db";
import { createEvent, createUser, get, none, params, post, signIn } from "../helpers/mobileApi";
import { REFRESH_REUSE_GRACE_MS } from "@/lib/mobileAuth";
import { POST as login } from "@/app/api/mobile/v1/auth/login/route";
import { POST as refresh } from "@/app/api/mobile/v1/auth/refresh/route";
import { POST as logoutAll } from "@/app/api/mobile/v1/auth/logout-all/route";
import { GET as me } from "@/app/api/mobile/v1/me/route";
import { GET as myRegistrations } from "@/app/api/mobile/v1/me/registrations/route";
import { POST as cancelMine } from "@/app/api/mobile/v1/me/registrations/[rsvpId]/cancel/route";
import { GET as eventDetail } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/route";
import { GET as guestList } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/route";
import { POST as approve } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/approve/route";
import { POST as checkIn } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/check-in/route";
import { POST as sendBroadcast } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/broadcasts/route";
import { GET as broadcastsMeta } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/broadcasts/meta/route";
import { GET as publicEvent } from "@/app/api/mobile/v1/public/events/[orgSlug]/[eventSlug]/route";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const ids = { orgA: "", orgB: "", eventA: "", eventB: "", owner: "", collaborator: "", attendee: "", other: "" };
const slugs = { orgA: `mob-a-${suffix}`, orgB: `mob-b-${suffix}`, eventA: `event-a-${suffix}`, eventB: `event-b-${suffix}` };
const email = (name: string) => `${name}-${suffix}@example.test`;

beforeAll(async () => {
  const [orgA, orgB] = await Promise.all([
    prisma.organisation.create({ data: { name: "Mobile A", slug: slugs.orgA } }),
    prisma.organisation.create({ data: { name: "Mobile B", slug: slugs.orgB } }),
  ]);
  ids.orgA = orgA.id;
  ids.orgB = orgB.id;
  for (const name of ["owner", "collaborator", "attendee", "other"] as const) ids[name] = await createUser(email(name === "collaborator" ? "collab" : name), name);
  ids.eventA = await createEvent(orgA.id, slugs.eventA);
  ids.eventB = await createEvent(orgB.id, slugs.eventB);
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: orgA.id, role: "OWNER" } });
  await prisma.eventCollaborator.create({ data: { userId: ids.collaborator, eventId: ids.eventA, permissions: [EventPermission.CHECK_IN] } });
});

beforeEach(() => {
  published.mockClear();
  web.session = null;
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.orgA, ids.orgB].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.collaborator, ids.attendee, ids.other].filter(Boolean) } } });
});

describe.sequential("mobile API: sessions, tenancy, check-in and tickets", () => {
  it("signs in, rotates refresh tokens, and revokes the session when a rotated token is reused", async () => {
    const first = await signIn(email("attendee"));
    const stored = await prisma.mobileSession.findFirstOrThrow({ where: { userId: ids.attendee }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(stored)).not.toContain(first.accessToken);
    expect(JSON.stringify(stored)).not.toContain(first.refreshToken);
    expect(stored.platform).toBe("android");

    const rotated = await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: first.refreshToken, deviceId: first.deviceId }), none);
    expect(rotated.status).toBe(200);
    const second = (await rotated.json()).data as { accessToken: string; refreshToken: string };
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect((await me(get("/api/mobile/v1/me", first.accessToken), none)).status).toBe(401);
    expect((await me(get("/api/mobile/v1/me", second.accessToken), none)).status).toBe(200);

    // Replayed after the lost-response grace window: treated as a copied token.
    await prisma.mobileSession.update({ where: { id: stored.id }, data: { rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000) } });
    const replay = await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: first.refreshToken, deviceId: first.deviceId }), none);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    expect((await prisma.mobileSession.findUniqueOrThrow({ where: { id: stored.id } })).revokedAt).not.toBeNull();
    expect((await me(get("/api/mobile/v1/me", second.accessToken), none)).status).toBe(401);
    expect((await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: second.refreshToken, deviceId: first.deviceId }), none)).status).toBe(401);
    await expect(prisma.auditEvent.count({ where: { action: "MOBILE_REFRESH_TOKEN_REUSED", actorUserId: ids.attendee } })).resolves.toBe(1);
  });

  it("uses the generic credential error and the sign-in codes like web sign-in", async () => {
    const wrong = await login(post("/api/mobile/v1/auth/login", { email: email("attendee"), password: "nope nope nope", deviceId: "a".repeat(32) }), none);
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ ok: false, error: { code: "UNAUTHENTICATED", message: "Email or password is incorrect." } });
    const missing = await login(post("/api/mobile/v1/auth/login", { email: email("nobody"), password: "correct horse battery staple", deviceId: "a".repeat(32) }), none);
    await expect(missing.json()).resolves.toEqual({ ok: false, error: { code: "UNAUTHENTICATED", message: "Email or password is incorrect." } });
    const noDevice = await login(post("/api/mobile/v1/auth/login", { email: email("attendee"), password: "correct horse battery staple" }), none);
    expect(noDevice.status).toBe(400);
  });

  it("sign out everywhere and a session-version bump kill every mobile session", async () => {
    const phone = await signIn(email("other"), { deviceName: "Phone" });
    const tablet = await signIn(email("other"), { deviceName: "Tablet" });
    // Like the web, signing out everywhere needs a recent sign-in.
    await prisma.mobileSession.updateMany({ where: { userId: ids.other }, data: { authenticatedAt: new Date(Date.now() - 11 * 60_000) } });
    const stale = await logoutAll(post("/api/mobile/v1/auth/logout-all", {}, phone.accessToken), none);
    await expect(stale.json()).resolves.toMatchObject({ ok: false, error: { code: "REAUTH_REQUIRED" } });
    await prisma.mobileSession.updateMany({ where: { userId: ids.other }, data: { authenticatedAt: new Date() } });
    expect((await logoutAll(post("/api/mobile/v1/auth/logout-all", {}, phone.accessToken), none)).status).toBe(200);
    expect((await me(get("/api/mobile/v1/me", tablet.accessToken), none)).status).toBe(401);
    expect((await me(get("/api/mobile/v1/me", phone.accessToken), none)).status).toBe(401);
    await expect(prisma.mobileSession.count({ where: { userId: ids.other, revokedAt: null } })).resolves.toBe(0);

    const fresh = await signIn(email("other"), { deviceName: "Phone" });
    expect((await me(get("/api/mobile/v1/me", fresh.accessToken), none)).status).toBe(200);
    // A password change/reset or MFA change bumps sessionVersion.
    await prisma.user.update({ where: { id: ids.other }, data: { sessionVersion: { increment: 1 } } });
    expect((await me(get("/api/mobile/v1/me", fresh.accessToken), none)).status).toBe(401);
    expect((await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: fresh.refreshToken, deviceId: fresh.deviceId }), none)).status).toBe(401);
  });

  it("returns NOT_FOUND for another organisation's events and guests", async () => {
    const owner = await signIn(email("owner"));
    const pending = await prisma.rSVP.create({ data: { eventId: ids.eventB, attendeeKey: `guest:${email("b-pending")}`, guestEmail: email("b-pending"), guestName: "B", status: RsvpStatus.PENDING_APPROVAL } });
    expect((await eventDetail(get("/x", owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA }))).status).toBe(200);
    expect((await eventDetail(get("/x", owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventB }))).status).toBe(404);
    expect((await eventDetail(get("/x", owner.accessToken), params({ orgSlug: slugs.orgB, eventId: ids.eventB }))).status).toBe(404);
    expect((await approve(post("/x", {}, owner.accessToken), params({ orgSlug: slugs.orgB, eventId: ids.eventB, rsvpId: pending.id }))).status).toBe(404);
    expect((await approve(post("/x", {}, owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventB, rsvpId: pending.id }))).status).toBe(404);
    // An RSVP id from another event, addressed through the caller's own event.
    expect((await approve(post("/x", {}, owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA, rsvpId: pending.id }))).status).toBe(404);
    expect((await checkIn(post("/x", { rsvpId: pending.id }, owner.accessToken), params({ orgSlug: slugs.orgB, eventId: ids.eventB }))).status).toBe(404);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(RsvpStatus.PENDING_APPROVAL);
  });

  it("lets a CHECK_IN collaborator check in (through commitCheckInProjection) but not approve or email", async () => {
    const collaborator = await signIn(email("collab"));
    const confirmed = await prisma.rSVP.create({ data: { eventId: ids.eventA, attendeeKey: `guest:${email("door")}`, guestEmail: email("door"), guestName: "Door guest", status: RsvpStatus.CONFIRMED } });
    const pending = await prisma.rSVP.create({ data: { eventId: ids.eventA, attendeeKey: `guest:${email("wait")}`, guestEmail: email("wait"), guestName: "Pending guest", status: RsvpStatus.PENDING_APPROVAL } });
    const target = { orgSlug: slugs.orgA, eventId: ids.eventA };

    const scanned = await checkIn(post("/x", { rawInput: `https://events.example.test/ticket/${confirmed.checkInToken}` }, collaborator.accessToken), params(target));
    expect(scanned.status).toBe(200);
    const scannedBody = await scanned.json();
    expect(scannedBody.data).toMatchObject({ rsvpId: confirmed.id, alreadyCheckedIn: false });
    expect(JSON.stringify(scannedBody)).not.toContain(confirmed.checkInToken);
    expect(published).toHaveBeenCalledWith({ rsvpId: confirmed.id, checkedInAt: expect.any(Date) });
    await expect(prisma.checkInEvent.findFirstOrThrow({ where: { rsvpId: confirmed.id } })).resolves.toMatchObject({ source: "mobile-scan", actorUserId: ids.collaborator });

    const needsForce = await checkIn(post("/x", { rsvpId: pending.id }, collaborator.accessToken), params(target));
    expect(needsForce.status).not.toBe(200);

    expect((await approve(post("/x", {}, collaborator.accessToken), params({ ...target, rsvpId: pending.id }))).status).toBe(403);
    expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(RsvpStatus.PENDING_APPROVAL);
    expect((await broadcastsMeta(get("/x", collaborator.accessToken), params(target))).status).toBe(403);
    const send = await sendBroadcast(post("/x", { statuses: ["CONFIRMED"], subject: "Hi", body: "<p>Hello</p>" }, collaborator.accessToken), params(target));
    expect(send.status).toBe(403);
    await expect(prisma.eventBroadcast.count({ where: { eventId: ids.eventA } })).resolves.toBe(0);

    // The check-in desk sees guests, but never ticket tokens in the guest list.
    const guests = await guestList(get("/x", collaborator.accessToken), params(target));
    expect(guests.status).toBe(200);
    expect(JSON.stringify(await guests.json())).not.toContain(confirmed.checkInToken);

    const owner = await signIn(email("owner"));
    const approved = await approve(post("/x", {}, owner.accessToken), params({ ...target, rsvpId: pending.id }));
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({ ok: true, data: { rsvpId: pending.id, status: "CONFIRMED" } });
    await expect(prisma.auditEvent.count({ where: { action: "RSVP_APPROVED", targetId: pending.id, actorUserId: ids.owner } })).resolves.toBe(1);
  });

  it("exposes a ticket token only to its owner and cancels only the caller's own RSVP", async () => {
    const mine = await prisma.rSVP.create({ data: { eventId: ids.eventA, userId: ids.attendee, attendeeKey: `user:${ids.attendee}`, status: RsvpStatus.CONFIRMED } });
    const theirs = await prisma.rSVP.create({ data: { eventId: ids.eventA, userId: ids.other, attendeeKey: `user:${ids.other}`, status: RsvpStatus.CONFIRMED } });
    const attendee = await signIn(email("attendee"));
    const other = await signIn(email("other"));

    const registrations = await (await myRegistrations(get("/x", attendee.accessToken), none)).json();
    expect(registrations.data.upcoming).toEqual([expect.objectContaining({ rsvpId: mine.id, ticketToken: mine.checkInToken, canCancel: true })]);
    expect(JSON.stringify(registrations)).not.toContain(theirs.checkInToken);

    const page = await (await publicEvent(get("/x", attendee.accessToken), params({ orgSlug: slugs.orgA, eventSlug: slugs.eventA }))).json();
    expect(page.data.registration.myRsvp).toEqual({ rsvpId: mine.id, status: "CONFIRMED", ticketToken: mine.checkInToken });
    expect(JSON.stringify(page)).not.toContain(theirs.checkInToken);
    const anonymous = await (await publicEvent(get("/x"), params({ orgSlug: slugs.orgA, eventSlug: slugs.eventA }))).json();
    expect(anonymous.data.registration.myRsvp).toBeNull();

    expect((await cancelMine(post("/x", {}, attendee.accessToken), params({ rsvpId: theirs.id }))).status).toBe(404);
    await expect(prisma.rSVP.findUnique({ where: { id: theirs.id } })).resolves.not.toBeNull();
    expect((await cancelMine(post("/x", {}, attendee.accessToken), params({ rsvpId: mine.id }))).status).toBe(200);
    await expect(prisma.rSVP.findUnique({ where: { id: mine.id } })).resolves.toBeNull();
    expect((await cancelMine(post("/x", {}, other.accessToken), params({ rsvpId: theirs.id }))).status).toBe(200);
  });
});
