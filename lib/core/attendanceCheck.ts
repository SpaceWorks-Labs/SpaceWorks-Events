import "server-only";

/**
 * Attendance confirmation ("Are you still coming?", docs/ATTENDANCE.md). The
 * parts live in lib/core/attendanceCheck/: sending and reminders, one guest's
 * shared link, the Emails card status, the guest's reply and what a "No"
 * releases.
 */
export { ATTENDANCE_AUDIT } from "./attendanceCheck/shared";
export { loadAttendanceCheckStatus, loadAttendanceReplyCounts, previewAttendanceCheckSendForUser, type AttendanceCheckStatus } from "./attendanceCheck/status";
export { remindAttendanceChecksForUser, sendAttendanceChecksForUser, setAttendanceReleaseOnDeclineForUser } from "./attendanceCheck/send";
export { issueAttendanceLinkForUser } from "./attendanceCheck/link";
export { resolveAttendanceCheckByToken, respondToAttendanceCheck, type AttendanceFormView, type AttendanceReplyResult } from "./attendanceCheck/reply";
export { planRelease, releaseKindFor, type ReleasePlan } from "./attendanceCheck/release";
