import { EventPrivacyType, EventStatus } from "@prisma/client";
import { z } from "zod";
import { teamSettingsFields, validateTeamSettings } from "@/lib/validators/teams";
import { isReservedEventSlug, isReservedOrganisationSlug } from "@/lib/slug";
import { isUploadedImageUrl } from "@/lib/uploadUrl";
import {
  coverImageUrlSchema,
  eventPageLogoUrlSchema,
  optionalHttpUrlSchema,
  registrationCutoffSchema,
  slugRegex,
  timeZoneSchema,
  validateEventScheduleAndLocation,
} from "@/lib/validators/shared";

export const createOrganisationSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: z
    .string()
    .trim()
    .min(2, "Slug must be at least 2 characters")
    .max(64)
    .regex(slugRegex, "Use lowercase letters, numbers, and single hyphens")
    .refine((slug) => !isReservedOrganisationSlug(slug), "That URL is reserved"),
  description: z.string().trim().max(2000).optional().default(""),
  logoUrl: z.literal(""),
});

export const updateOrganisationSchema = z.object({
  organisationSlug: z.string().trim().min(1),
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2000).optional().default(""),
  logoUrl: z
    .string()
    .refine(isUploadedImageUrl, "Invalid uploaded image URL")
    .or(z.literal("")),
});

export const createEventSchema = z
  .object({
    organisationSlug: z.string().trim().min(1),
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(10000).optional(),
    aboutHtml: z.string().max(50_000),
    tags: z
      .preprocess(
        (v) => {
          const raw = String(v ?? "");
          const parts = raw
            .split(/[,\n]/g)
            .map((s) => s.trim().toLowerCase())
            .map((s) => s.replace(/\s+/g, " "))
            .filter(Boolean)
            .slice(0, 12);
          return Array.from(new Set(parts));
        },
        z.array(z.string().min(1).max(32)).optional(),
      )
      .optional(),
    coverImageUrl: coverImageUrlSchema,
    showRegistrationCount: z
      .preprocess((v) => v === true || v === "true" || v === "on", z.boolean())
      .optional()
      .default(true),
    startDateTime: z.coerce.date(),
    endDateTime: z.coerce.date(),
    timezone: timeZoneSchema,
    location: z.string().trim().max(500).optional().default(""),
    mapLinkUrl: optionalHttpUrlSchema,
    isOnline: z.preprocess(
      (v) => v === true || v === "true" || v === "on",
      z.boolean(),
    ),
    capacity: z.preprocess((v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }, z.number().int().positive().optional()),
    status: z.nativeEnum(EventStatus).optional().default(EventStatus.DRAFT),
    privacyType: z
      .nativeEnum(EventPrivacyType)
      .optional()
      .default(EventPrivacyType.PUBLIC),
    ...registrationCutoffSchema,
    ...teamSettingsFields,
  })
  .superRefine((data, ctx) => {
    validateTeamSettings(data, ctx);
    validateEventScheduleAndLocation(data, ctx);
    if (data.registrationClosesAt && data.registrationLeadMinutes != null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationClosesAt"],
        message: "Choose one registration cutoff mode.",
      });
    if (
      data.registrationClosesAt &&
      data.registrationClosesAt > data.startDateTime
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationClosesAt"],
        message: "Registration must close on or before the event starts.",
      });
    if (
      data.registrationLeadMinutes != null &&
      data.registrationLeadMinutes * 60_000 >
        data.startDateTime.getTime() - Date.now()
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationLeadMinutes"],
        message: "Registration cutoff cannot be before now.",
      });
  });

export const updateEventSchema = z
  .object({
    organisationSlug: z.string().trim().min(1),
    eventId: z.string().trim().min(1),
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(10000).optional(),
    tags: z
      .preprocess(
        (v) => {
          const raw = String(v ?? "");
          const parts = raw
            .split(/[,\n]/g)
            .map((s) => s.trim().toLowerCase())
            .map((s) => s.replace(/\s+/g, " "))
            .filter(Boolean)
            .slice(0, 12);
          return Array.from(new Set(parts));
        },
        z.array(z.string().min(1).max(32)).optional(),
      )
      .optional(),
    coverImageUrl: coverImageUrlSchema,
    showRegistrationCount: z
      .preprocess((v) => v === true || v === "true" || v === "on", z.boolean())
      .optional()
      .default(true),
    startDateTime: z.coerce.date(),
    endDateTime: z.coerce.date(),
    timezone: timeZoneSchema,
    location: z.string().trim().max(500).optional().default(""),
    mapLinkUrl: optionalHttpUrlSchema,
    isOnline: z.preprocess(
      (v) => v === true || v === "true" || v === "on",
      z.boolean(),
    ),
    capacity: z.preprocess((v) => {
      if (v === "" || v === null || v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }, z.number().int().positive().optional()),
    status: z.nativeEnum(EventStatus),
    privacyType: z.nativeEnum(EventPrivacyType),
    /** Only meaningful with APPROVAL_REQUIRED: list the event publicly while approving each sign-up. */
    listedPublicly: z
      .preprocess((v) => v === true || v === "true" || v === "on", z.boolean())
      .optional()
      .default(false),
    pageTagline: z.string().trim().max(240).optional(),
    pageLogoUrl: eventPageLogoUrlSchema,
    pageAboutHtml: z.string().max(50_000).optional(),
    ...registrationCutoffSchema,
    ...teamSettingsFields,
  })
  .superRefine((data, ctx) => {
    validateTeamSettings(data, ctx);
    // A started event stays editable; updateEvent only rejects moving the start into the past.
    validateEventScheduleAndLocation(data, ctx, { requireFutureStart: false });
    if (data.registrationClosesAt && data.registrationLeadMinutes != null)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationClosesAt"],
        message: "Choose one registration cutoff mode.",
      });
    if (
      data.registrationClosesAt &&
      data.registrationClosesAt > data.startDateTime
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["registrationClosesAt"],
        message: "Registration must close on or before the event starts.",
      });
  });

export const deleteEventSchema = z.object({
  organisationSlug: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
});

export const updateEventSlugSchema = z.object({
  organisationSlug: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
  slug: z
    .string()
    .trim()
    .min(2, "Slug must be at least 2 characters")
    .max(64)
    .regex(slugRegex, "Use lowercase letters, numbers, and single hyphens")
    .refine((slug) => !isReservedEventSlug(slug), "That URL is reserved"),
});

export const cloneEventSchema = z.object({
  organisationSlug: z.string().trim().min(1),
  eventId: z.string().trim().min(1),
});
