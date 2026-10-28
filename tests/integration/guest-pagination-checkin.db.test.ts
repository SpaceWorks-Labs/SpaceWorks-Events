import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: async () => undefined }));
vi.mock("@/lib/publicUrl", () => ({ getRequestOrigin: async () => "https://events.example.test" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { INVITES_PAGE_SIZE, listEventInvitesPage } from "@/lib/eventDashboard/invites";
import { LIST_ROSTER_PAGE_SIZE, loadCheckInListRosterPage } from "@/lib/eventDashboard/checkInLists";
import { RECENT_CHECK_INS_PAGE_SIZE, listRecentCheckIns } from "@/lib/checkInRecent";
import { loadInvitesPage } from "@/app/actions/invites";
import { loadRecentCheckIns } from "@/app/actions/checkin";
import { loadListRosterPage } from "@/app/actions/checkin-lists";
import { checkInHelperId, event, inviterId, minutes, organisationId, orgSlug, otherAdminId, otherEvent, otherOrganisationId, otherOrgSlug, seedGuestPaging, tearDownGuestPaging, walk } from "./helpers/guestPagination";

// Server-side paging for invites, the check-in desk and check-in list rosters (see guest-pagination.db.test.ts).

beforeAll(seedGuestPaging);

afterAll(async () => {
  session.userId = null;
  await tearDownGuestPaging();
});

describe("invite pages", () => {
  beforeAll(async () => {
    await prisma.eventInvite.createMany({ data: Array.from({ length: 120 }, (_, i) => ({
      eventId: event.id,
      email: `invitee-${String(i).padStart(3, "0")}-${i % 10 === 0 ? "vip" : "std"}@example.test`,
      createdAt: i < 5 ? minutes(0) : minutes(i),
    })) });
    await prisma.eventInvite.create({ data: { eventId: otherEvent.id, email: "invitee-000-vip@example.test" } });
  });

  it("numbers pages over a stable order with totals", async () => {
    const expected = await prisma.eventInvite.findMany({ where: { eventId: event.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const result = await listEventInvitesPage({ eventId: event.id, organisationId }, { page });
      expect(result).toMatchObject({ page, pageCount: 3, total: 120, matching: 120, pageSize: INVITES_PAGE_SIZE });
      seen.push(...result.invites.map((invite) => invite.id));
    }
    expect(seen).toEqual(expected.map((invite) => invite.id));
    // Past the end shows the last page.
    expect((await listEventInvitesPage({ eventId: event.id, organisationId }, { page: 9 })).page).toBe(3);
  });

  it("searches by email on the server and keeps the badge total", async () => {
    const result = await listEventInvitesPage({ eventId: event.id, organisationId }, { query: "VIP" });
    expect(result).toMatchObject({ total: 120, matching: 12, page: 1, pageCount: 1 });
    expect(result.invites.every((invite) => invite.email.includes("vip"))).toBe(true);
    expect((await listEventInvitesPage({ eventId: event.id, organisationId: otherOrganisationId }, {})).total).toBe(0);
  });

  it("checks MANAGE_INVITATIONS in loadInvitesPage", async () => {
    session.userId = inviterId;
    const ok = await loadInvitesPage({ organisationSlug: orgSlug, eventId: event.id, page: 2 });
    expect(ok.ok && ok.data!.invites.length).toBe(INVITES_PAGE_SIZE);
    session.userId = checkInHelperId;
    expect(await loadInvitesPage({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = otherAdminId;
    expect(await loadInvitesPage({ organisationSlug: otherOrgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = null;
  });
});

describe("check-in desk paging", () => {
  it("walks every check-in once, newest first", async () => {
    // Two more check-ins at an identical time exercise the id tie-break.
    const tied = await prisma.rSVP.findMany({ where: { eventId: event.id, checkedInAt: null, status: RsvpStatus.CONFIRMED }, take: 2, select: { id: true } });
    await prisma.rSVP.updateMany({ where: { id: { in: tied.map((row) => row.id) } }, data: { checkedInAt: minutes(5000) } });
    const expected = await prisma.rSVP.findMany({ where: { eventId: event.id, checkedInAt: { not: null } }, orderBy: [{ checkedInAt: "desc" }, { id: "desc" }], select: { id: true } });
    expect(expected.length).toBeGreaterThan(RECENT_CHECK_INS_PAGE_SIZE);
    const { rows } = await walk((cursor) => listRecentCheckIns(event.id, cursor), RECENT_CHECK_INS_PAGE_SIZE);
    expect(rows.map((row) => row.rsvpId)).toEqual(expected.map((row) => row.id));
    expect(Object.keys(rows[0]!).sort()).toEqual(["checkedInAt", "displayName", "email", "rsvpId"]);
    expect((await listRecentCheckIns(otherEvent.id)).rows).toEqual([]);
  });

  it("checks CHECK_IN in loadRecentCheckIns", async () => {
    const first = await listRecentCheckIns(event.id);
    session.userId = checkInHelperId;
    const ok = await loadRecentCheckIns({ organisationSlug: orgSlug, eventId: event.id, cursor: first.nextCursor });
    expect(ok.ok && ok.data!.rows[0]!.rsvpId).not.toBe(first.rows[0]!.rsvpId);
    session.userId = inviterId;
    expect(await loadRecentCheckIns({ organisationSlug: orgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = otherAdminId;
    expect(await loadRecentCheckIns({ organisationSlug: otherOrgSlug, eventId: event.id })).toMatchObject({ ok: false });
    session.userId = null;
  });
});

describe("check-in list roster paging", () => {
  let list: { id: string; requiresEntryCheckIn: boolean };

  beforeAll(async () => {
    list = await prisma.checkInList.create({ data: { eventId: event.id, name: "Swag", sortOrder: 0 }, select: { id: true, requiresEntryCheckIn: true } });
    const confirmed = await prisma.rSVP.findMany({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED }, orderBy: { id: "asc" }, select: { id: true } });
    const waitlisted = await prisma.rSVP.findFirstOrThrow({ where: { eventId: event.id, status: RsvpStatus.WAITLISTED }, select: { id: true } });
    const collected = [...confirmed.filter((_, i) => i % 3 === 0), waitlisted];
    await prisma.checkInListRecord.createMany({ data: collected.map((row, i) => ({ listId: list.id, rsvpId: row.id, source: "online", checkedInAt: minutes(3000 + i) })) });
  });

  it("pages, filters and counts the whole roster on the server", async () => {
    const confirmed = await prisma.rSVP.count({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED } });
    const collected = await prisma.checkInListRecord.count({ where: { listId: list.id } });
    const collectedConfirmed = await prisma.checkInListRecord.count({ where: { listId: list.id, rsvp: { status: RsvpStatus.CONFIRMED } } });
    const first = await loadCheckInListRosterPage(event.id, list);
    expect(first.counts).toEqual({ all: confirmed + (collected - collectedConfirmed), collected, notCollected: confirmed - collectedConfirmed });
    expect(first.counts!.all).toBeGreaterThan(LIST_ROSTER_PAGE_SIZE);

    for (const filter of ["all", "collected", "notCollected"] as const) {
      const { rows } = await walk((cursor) => loadCheckInListRosterPage(event.id, list, { filter, cursor }), LIST_ROSTER_PAGE_SIZE);
      expect(new Set(rows.map((row) => row.rsvpId)).size).toBe(rows.length);
      expect(rows.length).toBe(first.counts![filter]);
      if (filter === "collected") expect(rows.every((row) => row.listCheckedInAt)).toBe(true);
      if (filter === "notCollected") expect(rows.every((row) => !row.listCheckedInAt && row.status === "CONFIRMED")).toBe(true);
    }

    const searched = await loadCheckInListRosterPage(event.id, list, { query: "signed-in-a" });
    expect(searched.rows).toHaveLength(1);
    expect(searched.counts!.all).toBe(1);
  });

  it("checks CHECK_IN and the list's event in loadListRosterPage", async () => {
    session.userId = checkInHelperId;
    const ok = await loadListRosterPage({ organisationSlug: orgSlug, eventId: event.id, listId: list.id, filter: "collected" });
    expect(ok.ok && ok.data!.rows.every((row) => row.listCheckedInAt)).toBe(true);
    session.userId = inviterId;
    expect(await loadListRosterPage({ organisationSlug: orgSlug, eventId: event.id, listId: list.id })).toMatchObject({ ok: false });
    session.userId = otherAdminId;
    expect(await loadListRosterPage({ organisationSlug: otherOrgSlug, eventId: otherEvent.id, listId: list.id })).toMatchObject({ ok: false, error: "List not found." });
    session.userId = null;
  });
});
