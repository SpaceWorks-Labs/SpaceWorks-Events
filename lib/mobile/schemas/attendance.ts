import { z } from "zod";
import { url } from "./core";

/*
 * Attendance confirmation in the mobile API (docs/ATTENDANCE.md). The link
 * token behind /attend/{token} is never part of any of these.
 */

export const attendanceResponseSchema = z.enum(["ATTENDING", "NOT_ATTENDING"]);

/** Organiser counts (owners and admins, like the Overview line); null until anyone was asked. */
export const attendanceCountsSchema = z.object({
  coming: z.number().int(),
  notComing: z.number().int(),
  noReply: z.number().int(),
  notAsked: z.number().int(),
}).strict();

/** The caller's own question for one registration. */
export const myAttendanceSchema = z.object({
  response: attendanceResponseSchema.nullable(),
  respondedAt: z.string().datetime().nullable(),
  note: z.string(),
  /** Why answers are closed: the event started or was cancelled, or the place is no longer confirmed. */
  closed: z.enum(["cancelled", "started", "notConfirmed"]).nullable(),
  /** What a No would release right now; null keeps the place. */
  releaseKind: z.enum(["free", "paid"]).nullable(),
  /** A paid release's refund under the policy, formatted; null when nothing comes back. */
  releaseRefund: z.string().nullable(),
}).strict();

export const myAttendanceDtoSchema = z.object({ attendance: myAttendanceSchema.nullable() }).strict();

export const attendanceReplyDtoSchema = z.object({
  response: attendanceResponseSchema,
  /** The place was released (the registration no longer exists). */
  released: z.boolean(),
  /** Why the place was kept after a No, when it was. */
  releaseFailed: z.string().nullable(),
}).strict();

/** A guest's link, shared by hand by an owner or admin. Shown once; it replaces any earlier link. */
export const attendanceLinkDtoSchema = z.object({ url, replaced: z.boolean() }).strict();
