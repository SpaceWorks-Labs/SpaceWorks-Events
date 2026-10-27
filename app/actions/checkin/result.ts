import type { AttendanceResponse } from "@prisma/client";
import { getCheckInDetails, getRegistrationDetails } from "@/lib/checkInDetails";
import { deskAttendanceState } from "@/lib/attendanceCheck";
import { attendeeLabel } from "./access";
import type { CheckInResultData } from "../checkin";

/**
 * The desk's view of a registration: name, door details, team, and the
 * attendance confirmation badge (docs/ATTENDANCE.md: the reply only, never
 * the guest's note). Add `DESK_ATTENDANCE_INCLUDE` to the RSVP query.
 */
export const DESK_ATTENDANCE_INCLUDE = { attendanceCheck: { select: { response: true } } } as const;

type DeskRsvp = {
  id: string;
  status: string;
  checkInToken: string;
  guestName: string | null;
  guestEmail: string | null;
  user: { name: string | null; email: string | null; } | null;
  team: { name: string; } | null;
  answers: Parameters<typeof getRegistrationDetails>[0];
  attendanceCheck: { response: AttendanceResponse | null; } | null;
};

export function deskResult(rsvp: DeskRsvp, state: { alreadyCheckedIn: boolean; checkedInAt: Date | null; }): CheckInResultData {
  return {
    rsvpId: rsvp.id,
    displayName: attendeeLabel(rsvp),
    email: rsvp.user?.email ?? rsvp.guestEmail,
    status: rsvp.status,
    alreadyCheckedIn: state.alreadyCheckedIn,
    checkedInAt: state.checkedInAt?.toISOString() ?? null,
    checkInQrToken: rsvp.checkInToken,
    checkInDetails: getCheckInDetails(rsvp.answers),
    registrationDetails: getRegistrationDetails(rsvp.answers),
    teamName: rsvp.team?.name ?? null,
    attendance: deskAttendanceState(rsvp.attendanceCheck),
  };
}
