import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: async () => undefined }));
vi.mock("@/lib/publicUrl", () => ({ getRequestOrigin: async () => "https://events.example.test" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { ATTENDEES_PAGE_SIZE } from "@/lib/attendeeListQuery";
import { listAttendeesPage } from "@/lib/eventDashboard/attendees";
import { listTeamMoveTargetsForOrganiser, TEAM_MOVE_TARGETS_PAGE_SIZE } from "@/lib/core/teams";
import { loadAttendeesPage } from "@/app/actions/guest-list";
import { searchMoveTargets } from "@/app/actions/team-admin";
import { GET as exportEmails } from "@/app/api/exports/events/[eventId]/attendee-emails/route";
import { adminId, checkInHelperId, event, memberId, organisationId, organiser, orgSlug, otherAdminId, otherOrganisationId, otherOrgSlug, seedGuestPaging, suffix, tearDownGuestPaging, walk } from "./helpers/guestPagination";

/*
 * Server-side paging for the Guests tab and the check-in desk: every page
 * walk returns each row exactly once in a stable order, filters and counts
 * agree with direct counts, and every loader and action stays inside its
 * event and organisation.
 */

// The invite, check-in desk and list roster pages are in guest-pagination-checkin.db.test.ts.

const scope = () => ({ kind: "event" as const, eventId: event.id, organisationId });
const options = { origin: "https://events.example.test", teamMode: true };

beforeAll(seedGuestPaging);

afterAll(async () => {
  session.userId = null;
  await tearDownGuestPaging();
});

describe("guest list paging", () => {
  it("walks every registration once, newest first with an id tie-break", async () => {
    const expected = await prisma.rSVP.findMany({ where: { eventId: event.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(expected.length).toBeGreaterThan(ATTENDEES_PAGE_SIZE * 2);
    const { rows, pages } = await walk((cursor) => listAttendeesPage(scope(), { cursor }, options), ATTENDEES_PAGE_SIZE);
    expect(rows.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    expect(pages).toBe(Math.ceil(expected.length / ATTENDEES_PAGE_SIZE));
    expect(rows[0]!.ticketUrl).toMatch(/^https:\/\/events\.example\.test\/ticket\//);
  });

  it("counts every chip in the database for the whole event, whatever the search and filters", async () => {
    const first = await listAttendeesPage(scope(), {}, options);
    const count = (where: object) => prisma.rSVP.count({ where: { eventId: event.id, ...where } });
    expect(first.total).toBe(await count({}));
    expect(first.counts).toEqual({
      all: await count({}),
      going: await count({ status: RsvpStatus.CONFIRMED }),
      waitlist: await count({ status: RsvpStatus.WAITLISTED }),
      approve: await count({ status: RsvpStatus.PENDING_APPROVAL }),
      declined: await count({ status: RsvpStatus.REJECTED }),
      checkedIn: await count({ checkedInAt: { not: null } }),
      notCheckedIn: await count({ status: RsvpStatus.CONFIRMED, checkedInAt: null }),
    });

    const soloGuests = await listAttendeesPage(scope(), { status: "going", kind: "guests", team: "solo" }, options);
    const expected = await count({ status: RsvpStatus.CONFIRMED, userId: null, teamId: null });
    expect(soloGuests.matching).toBe(expected);
    expect(soloGuests.counts).toEqual(first.counts);
    expect(soloGuests.rows.every((row) => row.status === "CONFIRMED" && !row.user && !row.team)).toBe(true);
    expect(soloGuests.total).toBe(first.total);

    const users = await listAttendeesPage(scope(), { kind: "users" }, options);
    expect(users.matching).toBe(2);
    expect(users.counts).toEqual(first.counts);
  });

  it("searches past the first page: names, emails and team names, inside this event only", async () => {
    const byName = await listAttendeesPage(scope(), { query: "ada needle" }, options);
    expect(byName.rows.map((row) => row.guestName)).toEqual(["Ada Needle"]);
    expect(byName.matching).toBe(1);
    expect(byName.counts!.all).toBe(await prisma.rSVP.count({ where: { eventId: event.id } }));

    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id, name: "Team 00 Beta" }, include: { _count: { select: { members: true } } } });
    const byTeam = await listAttendeesPage(scope(), { query: "team 00 beta" }, options);
    expect(byTeam.rows).toHaveLength(team._count.members);
    expect(byTeam.rows.every((row) => row.team?.id === team.id)).toBe(true);

    const byEmail = await listAttendeesPage(scope(), { query: `signed-in-b-${suffix}` }, options);
    expect(byEmail.rows.map((row) => row.user?.email)).toEqual([`signed-in-b-${suffix}@example.test`]);

    // LIKE wildcards are literal.
    expect((await listAttendeesPage(scope(), { query: "%" }, options)).rows).toEqual([]);
  });

  it("returns nothing for a scope outside its organisation or a forged cursor", async () => {
    const forged = await listAttendeesPage({ kind: "event", eventId: event.id, organisationId: otherOrganisationId }, {}, options);
    expect(forged.rows).toEqual([]);
    expect(forged.total).toBe(0);
    expect(forged.counts!.all).toBe(0);
    expect(forged.matching).toBe(0);
    expect((await listAttendeesPage(scope(), { cursor: "1.x' OR 1=1" }, options)).rows).toEqual([]);
  });

  it("checks registration management in loadAttendeesPage", async () => {
    session.userId = adminId;
    const ok = await loadAttendeesPage({ organisationSlug: orgSlug, eventId: event.id, status: "checkedIn" });
    expect(ok.ok && ok.data!.rows.every((row) => row.checkedInAt)).toBe(true);
    session.userId = memberId;
    expect(await loadAttendeesPage({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = checkInHelperId;
    expect(await loadAttendeesPage({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = otherAdminId;
    expect(await loadAttendeesPage({ organisationSlug: otherOrgSlug, eventId: event.id })).toMatchObject({ ok: false });
    expect(await loadAttendeesPage({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = null;
    expect(await loadAttendeesPage({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
  });

  it("exports emails for every guest matching the filters, not just a loaded page", async () => {
    const request = (query: string) => new Request(`https://events.example.test/api/exports/events/${event.id}/attendee-emails?${query}`);
    const params = { params: Promise.resolve({ eventId: event.id }) };
    session.userId = adminId;
    const response = await exportEmails(request("status=going&team=team"), params);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const lines = (await response.text()).replace(/^﻿/, "").trim().split("\n");
    const expected = await prisma.rSVP.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED, teamId: { not: null } } });
    expect(expected).toBeGreaterThan(ATTENDEES_PAGE_SIZE);
    expect(lines[0]).toBe("Name,Email");
    expect(lines).toHaveLength(expected + 1);

    session.userId = memberId;
    expect((await exportEmails(request(""), params)).status).toBe(404);
    session.userId = otherAdminId;
    expect((await exportEmails(request(""), params)).status).toBe(404);
    session.userId = adminId;
    expect((await exportEmails(request("status=nope"), params)).status).toBe(404);
    session.userId = null;
  });
});

describe("Move to team picker", () => {
  it("pages every team with room alphabetically, and never a full, declined or current team", async () => {
    const all = await prisma.team.findMany({
      where: { eventId: event.id },
      orderBy: [{ nameKey: "asc" }, { id: "asc" }],
      include: { _count: { select: { members: true } } },
    });
    const withRoom = all.filter((team) => team.status !== RsvpStatus.REJECTED && team._count.members < 3);
    const exclude = withRoom[0]!;
    const { rows, pages } = await walk(async (cursor) => {
      const page = await listTeamMoveTargetsForOrganiser(organiser, { cursor, excludeTeamId: exclude.id });
      return { rows: page.teams, nextCursor: page.nextCursor };
    }, TEAM_MOVE_TARGETS_PAGE_SIZE);
    expect(pages).toBeGreaterThan(1);
    expect(rows.map((team) => team.id)).toEqual(withRoom.slice(1).map((team) => team.id));
    expect(rows.every((team) => team.size < 3 && team.maxSize === 3)).toBe(true);
  });

  it("searches names in this event only", async () => {
    const found = await listTeamMoveTargetsForOrganiser(organiser, { query: "00 beta" });
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: event.id, name: "Team 00 Beta" }, include: { _count: { select: { members: true } } } });
    expect(found.teams.map((row) => row.id)).toEqual(team._count.members < 3 ? [team.id] : []);
    expect((await listTeamMoveTargetsForOrganiser(organiser, { query: "zulu" })).teams).toEqual([]);
    expect((await listTeamMoveTargetsForOrganiser({ ...organiser, organisationId: otherOrganisationId }, {})).teams).toEqual([]);
    expect((await listTeamMoveTargetsForOrganiser(organiser, { cursor: "garbage!" })).teams).toEqual([]);
  });

  it("checks the organiser in searchMoveTargets", async () => {
    session.userId = adminId;
    const ok = await searchMoveTargets({ organisationSlug: orgSlug, eventId: event.id });
    expect(ok.ok && ok.data!.teams.length).toBe(TEAM_MOVE_TARGETS_PAGE_SIZE);
    session.userId = memberId;
    expect(await searchMoveTargets({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = otherAdminId;
    expect(await searchMoveTargets({ organisationSlug: otherOrgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = null;
  });
});
