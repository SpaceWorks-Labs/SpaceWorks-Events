import { z } from "zod";
import { isValidTimeZone, zonedInputToIso } from "@/lib/timeZone";
import { isUploadedImageUrl } from "@/lib/uploadUrl";

export const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Only HTTP and HTTPS URLs are allowed");
export const optionalHttpUrlSchema = httpUrlSchema.optional().or(z.literal(""));
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1, "Timezone is required")
  .max(64)
  .refine(isValidTimeZone, "Select a valid IANA timezone");
/**
 * `YYYY-MM-DDTHH:mm[:ss[.sss]]` with no `Z` or UTC offset: a wall-clock time.
 * Event times are kept to the minute, so seconds are dropped rather than
 * letting the value fall through to the server's own clock.
 */
const ZONELESS_DATETIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?$/;

/**
 * A wall-clock date-time string (a `datetime-local` value with no `Z` or
 * offset) read in `timeZone`, never in the server's clock. Instants that carry
 * a `Z` or offset, and Date objects, pass through unchanged; a local time
 * that does not exist in the timezone (a DST gap) becomes an invalid value.
 */
export function zonedDateTimeInput(value: unknown, timeZone: string): unknown {
  if (typeof value !== "string") return value;
  const match = value.trim().match(ZONELESS_DATETIME);
  if (!match) return value;
  return zonedInputToIso(match[1], timeZone) ?? "invalid-local-time";
}

/**
 * Reads the payload's wall-clock `keys` in its own `timezone` before
 * validating, so a UTC container stores an Asia/Kolkata 19:00 start as
 * 13:30Z, and a DST-gap time fails validation.
 */
export function withZonedDateTimes<T extends z.ZodType>(keys: readonly string[], schema: T) {
  return z.preprocess((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    const timeZone = typeof record.timezone === "string" ? record.timezone.trim() : "";
    if (!timeZone || !isValidTimeZone(timeZone)) return input;
    let output = record;
    for (const key of keys) {
      const value = zonedDateTimeInput(record[key], timeZone);
      if (value !== record[key]) output = { ...output, [key]: value };
    }
    return output;
  }, schema);
}

export const coverImageUrlSchema = z
  .union([
    z.string().refine(isUploadedImageUrl, "Invalid uploaded image URL"),
    z.literal(""),
  ])
  .optional();
export const eventPageLogoUrlSchema = z
  .union([
    z.string().refine(isUploadedImageUrl, "Invalid uploaded image URL"),
    z.literal(""),
    z.null(),
  ])
  .optional();

export function isValidAttendeeName(value: string) {
  return (
    value.length <= 200 &&
    /\p{L}/u.test(value) &&
    !/[<>\u0000-\u001F\u007F]/.test(value)
  );
}

export const attendeeNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(200, "Name must be at most 200 characters")
  .refine(isValidAttendeeName, "Enter a valid name");

export const registrationCutoffSchema = {
  registrationClosesAt: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.date().optional(),
  ),
  registrationLeadMinutes: z.preprocess(
    (value) => (value === "" || value == null ? undefined : Number(value)),
    z.number().int().min(0).max(525_600).optional(),
  ),
};

export function validateEventScheduleAndLocation(
  data: {
    startDateTime: Date;
    endDateTime: Date;
    isOnline: boolean;
    location: string;
  },
  ctx: z.RefinementCtx,
  { requireFutureStart = true }: { requireFutureStart?: boolean } = {},
) {
  if (requireFutureStart && data.startDateTime < new Date()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["startDateTime"],
      message: "Start time must be now or in the future",
    });
  }
  if (data.endDateTime <= data.startDateTime) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endDateTime"],
      message: "End must be after start",
    });
  }
  if (data.isOnline) {
    if (!httpUrlSchema.safeParse(data.location).success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["location"],
        message: "Enter a valid HTTP(S) online meeting URL",
      });
    }
  } else if (data.location.trim().length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["location"],
      message: "Enter a physical location of at least 3 characters",
    });
  }
}

export const orgScoped = z.object({
  organisationSlug: z.string().trim().min(1),
});
