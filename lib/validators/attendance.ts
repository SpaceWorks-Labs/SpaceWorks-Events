import { z } from "zod";
import { ATTENDANCE_NOTE_MAX } from "@/lib/attendanceCheck";
import { orgScoped } from "@/lib/validators/shared";

/* Attendance confirmation (docs/ATTENDANCE.md). Sending is always a manual organiser action. */

export const attendanceCheckRefSchema = orgScoped.extend({
  eventId: z.string().trim().min(1).max(128),
}).strict();

export const attendanceCheckSettingsSchema = attendanceCheckRefSchema.extend({
  releaseOnDecline: z.boolean(),
}).strict();

/** One guest's attendance link, created or replaced by an organiser to share by hand. */
export const attendanceLinkSchema = attendanceCheckRefSchema.extend({
  rsvpId: z.string().trim().min(1).max(128),
}).strict();

/** The guest's reply on /attend/{token}. The token is shape-checked again before any lookup. */
export const attendanceReplySchema = z.object({
  token: z.string().trim().regex(/^[A-Za-z0-9_-]{43}$/, "This link is not valid."),
  response: z.enum(["ATTENDING", "NOT_ATTENDING"]),
  note: z
    .string()
    .max(ATTENDANCE_NOTE_MAX, `Keep the note to ${ATTENDANCE_NOTE_MAX} characters or fewer.`)
    .optional()
    .default("")
    // Control characters never reach a stored note or the CSV.
    .transform((note) => note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]+/g, " ").trim()),
}).strict();

/** The same reply from the guest's own app session: no token (the bearer session is the credential). */
export const attendanceMobileReplySchema = attendanceReplySchema.omit({ token: true }).strict();
