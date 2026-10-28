import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventPermission, EventStatus, RsvpStatus } from "@prisma/client";

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
import { createEvent, createUser, del, get, none, params, post, signIn } from "../helpers/mobileApi";
import { REFRESH_REUSE_GRACE_MS } from "@/lib/mobileAuth";
import { POST as refresh } from "@/app/api/mobile/v1/auth/refresh/route";
import { GET as me } from "@/app/api/mobile/v1/me/route";
import { GET as schedule } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/schedule/route";
import { POST as registrationState } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/registration/state/route";
import { DELETE as deleteGuest } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/[rsvpId]/route";
import { POST as restoreGuest } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/guests/restore/route";
import { updateEvent } from "@/app/actions/event";
import { updateEventSchema } from "@/lib/validators";

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

describe.sequential("mobile API: refresh retries, programme and day-of controls", () => {
  it("treats a quick retry of the previous refresh token as a lost response, not theft", async () => {
    const first = await signIn(email("attendee"), { deviceName: "Flaky Wi-Fi" });
    const rotated = await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: first.refreshToken, deviceId: first.deviceId }), none);
    const second = (await rotated.json()).data as { accessToken: string; refreshToken: string };
    const retry = await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: first.refreshToken, deviceId: first.deviceId }), none);
    expect(retry.status).toBe(401);
    expect((await me(get("/api/mobile/v1/me", second.accessToken), none)).status).toBe(200);

    // After the grace window the same replay revokes the session.
    const session = await prisma.mobileSession.findFirstOrThrow({ where: { deviceName: "Flaky Wi-Fi", userId: ids.attendee }, orderBy: { createdAt: "desc" } });
    await prisma.mobileSession.update({ where: { id: session.id }, data: { rotatedAt: new Date(Date.now() - REFRESH_REUSE_GRACE_MS - 1_000) } });
    expect((await refresh(post("/api/mobile/v1/auth/refresh", { refreshToken: first.refreshToken, deviceId: first.deviceId }), none)).status).toBe(401);
    expect((await me(get("/api/mobile/v1/me", second.accessToken), none)).status).toBe(401);
  });

  it("shows every organiser the programme with speakers and effective times, never another organisation's", async () => {
    const start = new Date(Date.now() + 2 * 60 * 60_000);
    const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
    const track = await prisma.eventScheduleTrack.create({ data: { eventId: ids.eventA, name: "Main stage" } });
    const speaker = await prisma.eventSpeaker.create({ data: { eventId: ids.eventA, name: "Ada Lovelace", slug: `ada-${suffix}`, headline: "Founder", photoUrl: "/api/uploads/speakers/ada.webp" } });
    const first = await prisma.eventSession.create({ data: {
      eventId: ids.eventA, trackId: track.id, title: "Keynote", slug: `keynote-${suffix}`, type: "Keynote", visibility: "PUBLISHED",
      startDateTime: at(0), endDateTime: at(45), delayMinutes: 10,
      speakers: { create: { speakerId: speaker.id } },
    } });
    const second = await prisma.eventSession.create({ data: {
      eventId: ids.eventA, trackId: track.id, title: "Draft panel", slug: `panel-${suffix}`, startDateTime: at(60), endDateTime: at(90),
    } });
    try {
      // A CHECK_IN-only collaborator has no `schedule` permission but still reads the programme.
      const collaborator = await signIn(email("collab"));
      const response = await schedule(get("/x", collaborator.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA }));
      expect(response.status).toBe(200);
      const sessions = (await response.json()).data.tracks.find((entry: { id: string }) => entry.id === track.id).sessions;
      expect(sessions).toEqual([
        expect.objectContaining({
          id: first.id, type: "Keynote", visibility: "PUBLISHED", delayMinutes: 10,
          effectiveStartDateTime: at(0).toISOString(),
          speakers: [{ id: speaker.id, name: "Ada Lovelace", headline: "Founder", organisation: null, photoUrl: "https://events.example.test/api/uploads/speakers/ada.webp" }],
        }),
        expect.objectContaining({
          id: second.id, visibility: "DRAFT", startDateTime: at(60).toISOString(),
          effectiveStartDateTime: at(70).toISOString(), effectiveEndDateTime: at(100).toISOString(), speakers: [],
        }),
      ]);

      const owner = await signIn(email("owner"));
      expect((await schedule(get("/x", owner.accessToken), params({ orgSlug: slugs.orgB, eventId: ids.eventB }))).status).toBe(404);
      expect((await schedule(get("/x", owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventB }))).status).toBe(404);
      const outsider = await signIn(email("other"));
      expect((await schedule(get("/x", outsider.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA }))).status).toBe(404);
    } finally {
      await prisma.eventSession.deleteMany({ where: { id: { in: [first.id, second.id] } } });
      await prisma.eventSpeaker.delete({ where: { id: speaker.id } });
      await prisma.eventScheduleTrack.delete({ where: { id: track.id } });
    }
  });

  it("closes sign-ups after the start without breaking the web cutoff rule", async () => {
    const owner = await signIn(email("owner"));
    const started = await prisma.event.create({ data: {
      organisationId: ids.orgA, title: "Started", slug: `started-${suffix}`,
      startDateTime: new Date(Date.now() - 30 * 60_000), endDateTime: new Date(Date.now() + 2 * 60 * 60_000),
      timezone: "UTC", status: EventStatus.PUBLISHED, location: "Main hall", registrationLeadMinutes: 15,
      page: { create: { isPublished: true } },
    } });
    const closed = await registrationState(post("/x", { open: false }, owner.accessToken), params({ orgSlug: slugs.orgA, eventId: started.id }));
    expect(closed.status).toBe(200);
    await expect(closed.json()).resolves.toMatchObject({ ok: true, data: { registrationOpen: false, registrationManuallyClosed: true, registrationClosesAt: started.startDateTime.toISOString() } });
    const row = await prisma.event.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.registrationClosesAt).toEqual(started.startDateTime);
    expect(row.registrationLeadMinutes).toBeNull();
    expect(row.registrationLeadBeforeManualClose).toBe(15);
    // What the dashboard form would submit for this event passes the cutoff rule.
    const issues = updateEventSchema.safeParse({
      organisationSlug: slugs.orgA, eventId: started.id, title: row.title, startDateTime: row.startDateTime, endDateTime: row.endDateTime,
      timezone: row.timezone, location: row.location, status: row.status, privacyType: row.privacyType, registrationClosesAt: row.registrationClosesAt?.toISOString(),
    }).error?.issues ?? [];
    expect(issues.filter((issue) => issue.path[0] === "registrationClosesAt")).toEqual([]);
  });

  it("reopens only after a manual close, restoring the organiser's lead time; a web save clears the snapshot", async () => {
    const owner = await signIn(email("owner"));
    const upcoming = await prisma.event.create({ data: {
      organisationId: ids.orgA, title: "Upcoming", slug: `upcoming-${suffix}`,
      startDateTime: new Date(Date.now() + 5 * 24 * 60 * 60_000), endDateTime: new Date(Date.now() + 5 * 24 * 60 * 60_000 + 7_200_000),
      timezone: "UTC", status: EventStatus.PUBLISHED, location: "Main hall", registrationLeadMinutes: 60,
      page: { create: { isPublished: true } },
    } });
    const target = params({ orgSlug: slugs.orgA, eventId: upcoming.id });

    const premature = await registrationState(post("/x", { open: true }, owner.accessToken), target);
    expect(premature.status).toBe(409);
    await expect(premature.json()).resolves.toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    expect((await registrationState(post("/x", { open: false }, owner.accessToken), target)).status).toBe(200);
    expect((await registrationState(post("/x", { open: false }, owner.accessToken), target)).status).toBe(200);
    const reopened = await registrationState(post("/x", { open: true }, owner.accessToken), target);
    await expect(reopened.json()).resolves.toMatchObject({ ok: true, data: { registrationOpen: true, registrationManuallyClosed: false, registrationClosedReason: null } });
    await expect(prisma.event.findUniqueOrThrow({ where: { id: upcoming.id } })).resolves.toMatchObject({
      registrationLeadMinutes: 60, registrationClosesAt: null, registrationManuallyClosedAt: null, registrationLeadBeforeManualClose: null,
    });

    // Close again, then save the dashboard form: its explicit cutoff wins and there is nothing to reopen.
    expect((await registrationState(post("/x", { open: false }, owner.accessToken), target)).status).toBe(200);
    web.session = { user: { id: ids.owner } };
    const saved = await updateEvent({
      organisationSlug: slugs.orgA, eventId: upcoming.id, title: "Upcoming", startDateTime: upcoming.startDateTime.toISOString(),
      endDateTime: upcoming.endDateTime.toISOString(), timezone: "UTC", location: "Main hall", status: "PUBLISHED", privacyType: "PUBLIC",
      registrationLeadMinutes: 30,
    });
    expect(saved).toEqual({ ok: true });
    await expect(prisma.event.findUniqueOrThrow({ where: { id: upcoming.id } })).resolves.toMatchObject({
      registrationLeadMinutes: 30, registrationClosesAt: null, registrationManuallyClosedAt: null, registrationLeadBeforeManualClose: null, registrationCutoffBeforeManualClose: null,
    });
    expect((await registrationState(post("/x", { open: true }, owner.accessToken), target)).status).toBe(409);
  });

  it("restores a deleted guest only through the event it was deleted from", async () => {
    const owner = await signIn(email("owner"));
    const otherEvent = await createEvent(ids.orgA, `other-${suffix}`);
    const guest = await prisma.rSVP.create({ data: { eventId: ids.eventA, attendeeKey: `guest:${email("undo")}`, guestEmail: email("undo"), guestName: "Undo", status: RsvpStatus.WAITLISTED } });
    const deleted = await deleteGuest(del("/x", owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA, rsvpId: guest.id }));
    const { undoId } = (await deleted.json()).data as { undoId: string };
    expect((await restoreGuest(post("/x", { undoId }, owner.accessToken), params({ orgSlug: slugs.orgA, eventId: otherEvent }))).status).toBe(404);
    await expect(prisma.rSVP.findUnique({ where: { id: guest.id } })).resolves.toBeNull();
    expect((await restoreGuest(post("/x", { undoId }, owner.accessToken), params({ orgSlug: slugs.orgA, eventId: ids.eventA }))).status).toBe(200);
    await expect(prisma.rSVP.count({ where: { eventId: ids.eventA, guestEmail: email("undo") } })).resolves.toBe(1);
  });
});
