import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { crewKindLabel } from "@/lib/crewKind";
import { formatHours } from "./math";

/** Volunteer hours CSV (docs/VOLUNTEERS.md): names, never emails, tokens or adjustment reasons. */
export const VOLUNTEER_HOURS_HEADER = ["Volunteer", "Kind", "Shift", "Zone", "Shift starts", "Shift ends", "Sign-up", "Attendance", "Checked in", "Checked out", "Break minutes", "Minutes", "Hours", "Hours status"] as const;

const iso = (value: Date | null) => value?.toISOString() ?? "";

const PAGE_SIZE = 1_000;

const signupSelect = {
  id: true, queuedAt: true, status: true, attendance: true, checkedInAt: true, checkedOutAt: true, breakMinutes: true,
  crewMember: { select: { name: true, kind: true } },
  shift: { select: { title: true, zone: true, startsAt: true, endsAt: true } },
  hours: { select: { minutes: true, state: true } },
} satisfies Prisma.VolunteerShiftSignupSelect;

type Signup = Prisma.VolunteerShiftSignupGetPayload<{ select: typeof signupSelect }>;

/** Sign-ups after `last` in the export's order: shift start, then queue time, then id. */
function after(last: Signup): Prisma.VolunteerShiftSignupWhereInput {
  const startsAt = last.shift.startsAt;
  return {
    OR: [
      { shift: { startsAt: { gt: startsAt } } },
      { shift: { startsAt }, queuedAt: { gt: last.queuedAt } },
      { shift: { startsAt }, queuedAt: last.queuedAt, id: { gt: last.id } },
    ],
  };
}

function toRow(row: Signup): string[] {
  return [
    row.crewMember.name, crewKindLabel(row.crewMember.kind), row.shift.title, row.shift.zone, iso(row.shift.startsAt), iso(row.shift.endsAt),
    row.status, row.attendance, iso(row.checkedInAt), iso(row.checkedOutAt), String(row.breakMinutes),
    row.hours ? String(row.hours.minutes) : "", row.hours ? formatHours(row.hours.minutes) : "", row.hours?.state ?? "",
  ];
}

/**
 * Every sign-up of the event as CSV rows, one keyset page at a time in a
 * stable order, so the file is complete however many sign-ups there are and
 * only one page is held in memory. `pageSize` is for tests.
 */
export async function* volunteerHoursBatches(eventId: string, pageSize = PAGE_SIZE): AsyncGenerator<string[][]> {
  let last: Signup | null = null;
  for (;;) {
    const page: Signup[] = await prisma.volunteerShiftSignup.findMany({
      where: { eventId, ...(last ? after(last) : {}) },
      orderBy: [{ shift: { startsAt: "asc" } }, { queuedAt: "asc" }, { id: "asc" }],
      take: pageSize,
      select: signupSelect,
    });
    if (page.length) yield page.map(toRow);
    if (page.length < pageSize) return;
    last = page.at(-1)!;
  }
}
