import { Chip, type ChipTone } from "@/components/ui/display";
import { attendanceBadgeLabel, type AttendanceReleaseOutcome, type AttendanceState } from "@/lib/attendanceCheck";

const ATTENDANCE_TONES: Record<AttendanceState, ChipTone> = {
  coming: "success",
  notComing: "danger",
  noReply: "warning",
  notAsked: "outline",
};

/**
 * The guest's attendance confirmation reply (docs/ATTENDANCE.md), in Guests ·
 * People and at the check-in desk. Nothing when they were never asked; a
 * "No" that kept a paid place reads "Said No · paid". Never the note.
 */
export function AttendanceChip({ state, outcome }: { state: AttendanceState | null | undefined; outcome?: AttendanceReleaseOutcome | null; }) {
  if (!state) return null;
  return (
    <Chip size="sm" tone={ATTENDANCE_TONES[state]}>
      <span className="sr-only">Attendance confirmation: </span>
      {attendanceBadgeLabel(state, outcome)}
    </Chip>
  );
}
