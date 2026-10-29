import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
const audit = vi.hoisted(() => ({ events: [] as Array<{ action: string; metadata?: Record<string, unknown> }> }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: async (event: { action: string; metadata?: Record<string, unknown> }) => void audit.events.push(event) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import type { Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { volunteerHoursBatches } from "@/lib/volunteer/export";
import { GET as exportHours } from "@/app/api/exports/events/[eventId]/volunteer-hours/route";
import { crew, setUpCrewOrgs, tearDownCrewOrgs } from "./helpers/crew";
import { makeShift, shiftsEvent, volunteer } from "./helpers/volunteers";
import { csv } from "./helpers/filteredExports";

/*
 * Volunteer-hours CSV (audit: Data Layer, Privacy): every sign-up is
 * exported, page after page in the stable order (shift start, queue time,
 * id), with no silent ceiling, and the audit counts the rows sent.
 */

let event: Event;
let expected: Array<[string, string]> = [];

describe.sequential("volunteer hours export", () => {
  beforeAll(async () => {
    await setUpCrewOrgs("vexport");
    event = await shiftsEvent();
    // Two shifts start together, so the order falls through to queue time and id.
    const early = await makeShift(event, { startIn: 60, title: "Early" });
    const twinA = await makeShift(event, { startIn: 120, title: "Twin A" });
    const twinB = await prisma.volunteerShift.update({ where: { id: (await makeShift(event, { startIn: 300, title: "Twin B" })).id }, data: { startsAt: twinA.startsAt, signupDeadline: twinA.startsAt } });
    const members = await Promise.all(["Ada", "Grace", "Linus"].map((name) => volunteer(event, { name })));
    const queued = new Date("2030-01-01T09:00:00.000Z");
    for (const shift of [twinB, early, twinA]) {
      for (const [index, { member }] of members.entries()) {
        // Equal queue times inside each shift but one, so ids decide.
        await prisma.volunteerShiftSignup.create({ data: { eventId: event.id, shiftId: shift.id, crewMemberId: member.id, status: "APPROVED", queuedAt: index === 2 ? new Date(queued.getTime() - 1) : queued } });
      }
    }
    const all = await prisma.volunteerShiftSignup.findMany({
      where: { eventId: event.id },
      orderBy: [{ shift: { startsAt: "asc" } }, { queuedAt: "asc" }, { id: "asc" }],
      select: { crewMember: { select: { name: true } }, shift: { select: { title: true } } },
    });
    expected = all.map((row) => [row.crewMember.name, row.shift.title]);
    session.userId = crew.organiserId;
  });
  afterAll(() => tearDownCrewOrgs());

  it("reads every sign-up across small pages, in order, without repeats", async () => {
    const batches: string[][][] = [];
    for await (const batch of volunteerHoursBatches(event.id, 2)) batches.push(batch);
    expect(expected).toHaveLength(9);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 2, 2, 1]);
    expect(batches.flat().map((row) => [row[0], row[2]])).toEqual(expected);
    // An exact multiple of the page size ends cleanly too.
    const thirds: string[][][] = [];
    for await (const batch of volunteerHoursBatches(event.id, 3)) thirds.push(batch);
    expect(thirds.flat().map((row) => [row[0], row[2]])).toEqual(expected);
  });

  it("streams the whole file and audits the rows sent", async () => {
    audit.events.length = 0;
    const { header, rows } = await csv(await exportHours(new Request(`https://events.example.test/api/exports/events/${event.id}/volunteer-hours`), { params: Promise.resolve({ eventId: event.id }) }));
    expect(header[0]).toBe("Volunteer");
    expect(rows.map((row) => [row[0], row[2]])).toEqual(expected);
    expect(audit.events).toEqual([expect.objectContaining({ action: "VOLUNTEER_HOURS_EXPORTED", metadata: { rows: 9, complete: true } })]);
  });
});
