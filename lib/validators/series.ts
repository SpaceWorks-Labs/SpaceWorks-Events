import { EventPrivacyType, EventStatus } from "@prisma/client";
import { z } from "zod";
import { orgScoped, timeZoneSchema } from "@/lib/validators/shared";
import { seriesTeamSettingsRefusal } from "@/lib/validators/teams";

export const createSeriesSchema = z
  .object({
    organisationSlug: z.string().trim().min(1),
    title: z.string().trim().min(1, "Title is required").max(200),
    description: z.string().trim().max(10000).optional().default(""),
    anchorStartDateTime: z.coerce.date(),
    anchorEndDateTime: z.coerce.date(),
    rruleLine: z
      .string()
      .trim()
      .min(1, "Recurrence rule is required")
      .max(2048)
      .refine((value) => !/[\r\n]/.test(value), "Use a single RRULE line"),
    timezone: timeZoneSchema,
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
    ...seriesTeamSettingsRefusal,
  })
  .refine((d) => d.anchorEndDateTime > d.anchorStartDateTime, {
    message: "End must be after start",
    path: ["anchorEndDateTime"],
  })
  .refine(
    (d) =>
      d.anchorEndDateTime.getTime() - d.anchorStartDateTime.getTime() <=
      2_147_483_647,
    {
      message: "A recurring occurrence must be shorter than 24 days",
      path: ["anchorEndDateTime"],
    },
  );

export const updateSeriesMetaSchema = orgScoped.extend({
  eventSeriesId: z.string().trim().min(1),
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().trim().max(10000).optional().default(""),
  timezone: timeZoneSchema,
  capacity: z.preprocess((v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }, z.number().int().positive().optional()),
  status: z.nativeEnum(EventStatus),
  privacyType: z.nativeEnum(EventPrivacyType),
  ...seriesTeamSettingsRefusal,
});

export const deleteSeriesSchema = orgScoped.extend({
  eventSeriesId: z.string().trim().min(1),
});
