import "server-only";

import { prisma } from "@/lib/db";
import { crewKindLabel } from "@/lib/crewKind";
import { formatHours } from "./math";

/** Volunteer hours CSV (docs/VOLUNTEERS.md): names, never emails, tokens or adjustment reasons. */
export const VOLUNTEER_HOURS_HEADER = ["Volunteer", "Kind", "Shift", "Zone", "Shift starts", "Shift ends", "Sign-up", "Attendance", "Checked in", "Checked out", "Break minutes", "Minutes", "Hours", "Hours status"] as const;

const iso = (value: Date | null) => value?.toISOString() ?? "";

export async function volunteerHoursRows(eventId: string): Promise<string[][]> {
  const signups = await prisma.volunteerShiftSignup.findMany({
    where: { eventId },
    orderBy: [{ shift: { startsAt: "asc" } }, { queuedAt: "asc" }, { id: "asc" }],
    take: 20_000,
    select: {
      status: true, attendance: true, checkedInAt: true, checkedOutAt: true, breakMinutes: true,
      crewMember: { select: { name: true, kind: true } },
      shift: { select: { title: true, zone: true, startsAt: true, endsAt: true } },
      hours: { select: { minutes: true, state: true } },
    },
  });
  return signups.map((row) => [
    row.crewMember.name, crewKindLabel(row.crewMember.kind), row.shift.title, row.shift.zone, iso(row.shift.startsAt), iso(row.shift.endsAt),
    row.status, row.attendance, iso(row.checkedInAt), iso(row.checkedOutAt), String(row.breakMinutes),
    row.hours ? String(row.hours.minutes) : "", row.hours ? formatHours(row.hours.minutes) : "", row.hours?.state ?? "",
  ]);
}
