import "server-only";

import { prisma } from "@/lib/db";
import { parseCheckInPayload } from "@/lib/checkIn";
import { alreadyInListMessage, listCheckInSchema, listLookupSchema, undoListCheckInSchema } from "@/lib/checkInLists";
import { commitListCheckIn, commitUndoListCheckIn } from "@/lib/checkInListMutations";
import type { ActionResult } from "@/app/actions/org";
import { flattenZodErrors } from "@/app/actions/utils";
import { z } from "zod";
import { LIST_ROSTER_FILTERS, loadCheckInListRosterPage, type ListRosterPage } from "@/lib/eventDashboard/checkInLists";
import {
  attendeeLabel,
  fail,
  resolveEvent,
  revalidateLists,
  type CheckInListOptions,
  type ListCheckInResultData,
  type ListLookupRow,
} from "./shared";

/** The list desk: checking guests into and out of a list, search, and the roster pages. */

const rsvpInclude = { user: { select: { name: true, email: true } } } as const;

export async function checkInToListForUser(actorUserId: string | null, input: unknown, options: CheckInListOptions = {}): Promise<ActionResult<ListCheckInResultData>> {
  const parsed = listCheckInSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, listId, rawInput, rsvpId, force } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "checkIn", "checkin");
  if (!ctx.ok) return ctx;

  const list = await prisma.checkInList.findFirst({ where: { id: listId, eventId: ctx.event.id }, select: { id: true, name: true, archived: true } });
  if (!list) return fail("List not found.");
  if (list.archived) return fail("This list is archived and read-only.");

  let rsvp;
  if (rawInput) {
    // The same parser as entry: ticket URL, raw token, or typed code.
    const token = parseCheckInPayload(rawInput);
    if (!token) return fail("Could not read a ticket code from that input.");
    rsvp = await prisma.rSVP.findUnique({ where: { checkInToken: token }, include: rsvpInclude });
    if (!rsvp) return fail("No matching ticket found.");
    if (rsvp.eventId !== ctx.event.id) return fail("This ticket is not for this event.");
  } else {
    rsvp = await prisma.rSVP.findFirst({ where: { id: rsvpId, eventId: ctx.event.id }, include: rsvpInclude });
    if (!rsvp) return fail("RSVP not found.");
  }

  const committed = await commitListCheckIn({
    listId: list.id,
    rsvpId: rsvp.id,
    actorUserId: ctx.actorUserId,
    source: options.source ?? "online",
    checkedInAt: new Date(),
    force: Boolean(force),
  });
  if (committed.state === "missing") return fail("RSVP not found.");
  if (committed.state === "ineligible") {
    return committed.gate.needsForce ? fail(committed.gate.reason, { needsForce: true }) : fail(committed.gate.reason);
  }

  const already = committed.state === "already-checked-in";
  if (!already) revalidateLists(ctx.org.slug, ctx.event.id);
  return {
    ok: true,
    data: {
      listId: list.id,
      listName: list.name,
      rsvpId: rsvp.id,
      displayName: attendeeLabel(rsvp),
      email: rsvp.user?.email ?? rsvp.guestEmail,
      status: rsvp.status,
      alreadyCheckedIn: already,
      checkedInAt: committed.checkedInAt.toISOString(),
      entryCheckedInAt: rsvp.checkedInAt?.toISOString() ?? null,
      message: already ? alreadyInListMessage(list.name, committed.checkedInAt, ctx.event.timezone) : `Checked in to ${list.name}`,
    },
  };
}

export async function undoListCheckInForUser(actorUserId: string | null, input: unknown, options: CheckInListOptions = {}): Promise<ActionResult> {
  const parsed = undoListCheckInSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, listId, rsvpId } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "checkIn", "checkin");
  if (!ctx.ok) return ctx;

  const [list, rsvp] = await Promise.all([
    prisma.checkInList.findFirst({ where: { id: listId, eventId: ctx.event.id }, select: { id: true } }),
    prisma.rSVP.findFirst({ where: { id: rsvpId, eventId: ctx.event.id }, select: { id: true } }),
  ]);
  if (!list) return fail("List not found.");
  if (!rsvp) return fail("RSVP not found.");

  const result = await commitUndoListCheckIn({ listId: list.id, rsvpId: rsvp.id, actorUserId: ctx.actorUserId, source: options.source ?? "online" });
  if (result === "missing") return fail("List not found.");
  if (result === "archived") return fail("This list is archived and read-only.");
  if (result === "not-checked-in") return fail("This guest is not checked in to this list.");
  revalidateLists(ctx.org.slug, ctx.event.id);
  return { ok: true };
}

/** Search for the list desk: the entry lookup plus each guest's state in this list. */
export async function lookupListAttendeesForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ rows: ListLookupRow[] }>> {
  const parsed = listLookupSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, listId, query } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "checkIn", "checkin");
  if (!ctx.ok) return ctx;

  const list = await prisma.checkInList.findFirst({ where: { id: listId, eventId: ctx.event.id }, select: { id: true } });
  if (!list) return fail("List not found.");

  const q = query.trim();
  const rsvps = await prisma.rSVP.findMany({
    where: {
      eventId: ctx.event.id,
      OR: [
        { guestEmail: { contains: q, mode: "insensitive" } },
        { guestName: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { name: { contains: q, mode: "insensitive" } } },
      ],
    },
    take: 12,
    orderBy: { createdAt: "desc" },
    include: { ...rsvpInclude, checkInListRecords: { where: { listId: list.id }, select: { checkedInAt: true } } },
  });
  return {
    ok: true,
    data: {
      rows: rsvps.map((r) => ({
        rsvpId: r.id,
        displayName: attendeeLabel(r),
        email: r.user?.email ?? r.guestEmail,
        status: r.status,
        entryCheckedInAt: r.checkedInAt?.toISOString() ?? null,
        listCheckedInAt: r.checkInListRecords[0]?.checkedInAt.toISOString() ?? null,
      })),
    },
  };
}

const listRosterPageSchema = z
  .object({
    organisationSlug: z.string().trim().min(1).max(120),
    eventId: z.string().trim().min(1).max(128),
    listId: z.string().trim().min(1).max(128),
    filter: z.enum(LIST_ROSTER_FILTERS).optional(),
    query: z.string().max(100).optional(),
    cursor: z.string().max(160).nullable().optional(),
  })
  .strict();

/**
 * One page of "Guests for <list>" on the list desk (filter chips, search,
 * "Show more"). Read-only, with the same CHECK_IN access as checking guests
 * into the list, on the search rate-limit bucket; the list is re-read inside
 * the event.
 */
export async function listRosterPageForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<ListRosterPage>> {
  const parsed = listRosterPageSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  const { organisationSlug, eventId, listId, filter, query, cursor } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "checkIn", "search");
  if (!ctx.ok) return ctx;
  const list = await prisma.checkInList.findFirst({ where: { id: listId, eventId: ctx.event.id }, select: { id: true, requiresEntryCheckIn: true } });
  if (!list) return fail("List not found.");
  return { ok: true, data: await loadCheckInListRosterPage(ctx.event.id, list, { filter, query: query?.trim() ?? "", cursor: cursor ?? null }) };
}
