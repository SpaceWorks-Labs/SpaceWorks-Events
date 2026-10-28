import { z } from "zod";
import {
  ADMISSION_CRITERIA_LIMIT,
  ADMISSION_CRITERION_MAX,
  ADMISSION_DECISION_NOTE_MAX,
  ADMISSION_GUIDANCE_MAX,
  ADMISSION_NOTES_MAX,
  ADMISSION_OVERRIDE_REASON_MAX,
  ADMISSION_RSVP_DAYS_MAX,
  ADMISSION_RSVP_DAYS_MIN,
  ADMISSION_STAGE_NAME_MAX,
  REVIEWS_PER_APPLICATION_MAX,
  REVIEWS_PER_APPLICATION_MIN,
} from "@/lib/admission/rules";

/* Boundary validation for the application actions (docs/ADMISSION.md). */

const id = z.string().trim().min(1).max(128);
export const eventScope = z.object({ organisationSlug: z.string().trim().min(1).max(128), eventId: id });

export const enabledSchema = eventScope.extend({ enabled: z.boolean() }).strict();

export const settingsSchema = eventScope.extend({
  mode: z.enum(["MANUAL", "AUTO"]),
  rsvpDays: z.number().int().min(ADMISSION_RSVP_DAYS_MIN).max(ADMISSION_RSVP_DAYS_MAX),
  offerCapacity: z.number().int().min(1).max(1_000_000).nullable(),
  emailOnStageAdvance: z.boolean(),
}).strict();

const isoDate = z.string().datetime().nullable();
export const stageFields = z.object({
  name: z.string().trim().min(1).max(ADMISSION_STAGE_NAME_MAX),
  reviewsPerApplication: z.number().int().min(REVIEWS_PER_APPLICATION_MIN).max(REVIEWS_PER_APPLICATION_MAX),
  blindReview: z.boolean(),
  freshEyes: z.boolean().optional(),
  criteria: z.array(z.string().trim().min(1).max(ADMISSION_CRITERION_MAX)).max(ADMISSION_CRITERIA_LIMIT).refine((list) => new Set(list.map((item) => item.toLowerCase())).size === list.length, "Each criterion once."),
  guidance: z.string().max(ADMISSION_GUIDANCE_MAX),
  opensAt: isoDate,
  closesAt: isoDate,
});
export const createStageSchema = eventScope.extend({ stage: stageFields }).strict();
export const updateStageSchema = eventScope.extend({ stageId: id, stage: stageFields, status: z.enum(["DRAFT", "OPEN", "CLOSED"]) }).strict();
export const stageRefSchema = eventScope.extend({ stageId: id }).strict();
export const panelSchema = eventScope.extend({ stageId: id, userIds: z.array(id).max(200) }).strict();

export const assignSchema = eventScope.extend({
  stageId: id,
  perApplication: z.number().int().min(REVIEWS_PER_APPLICATION_MIN).max(REVIEWS_PER_APPLICATION_MAX),
  mode: z.enum(["keep", "replace"]),
  strategy: z.enum(["balanced", "random"]),
  reviewerIds: z.array(id).min(1).max(200),
  seed: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  fingerprint: z.string().min(1).max(64).optional(),
}).strict();
export const manualAssignSchema = eventScope.extend({ stageId: id, applicationId: id, reviewerUserId: id }).strict();
export const assignmentRefSchema = eventScope.extend({ assignmentId: id }).strict();

export const draftSchema = eventScope.extend({
  applicationIds: z.array(id).min(1).max(200),
  outcome: z.enum(["ADVANCE", "ACCEPT", "WAITLIST", "REJECT"]),
  note: z.string().max(ADMISSION_DECISION_NOTE_MAX).optional(),
  overrideReason: z.string().trim().max(ADMISSION_OVERRIDE_REASON_MAX).nullable().optional(),
  sourceRank: z.number().int().min(1).max(100_000).nullable().optional(),
}).strict();
export const applicationsSchema = eventScope.extend({ applicationIds: z.array(id).min(1).max(200) }).strict();
export const applicationRefSchema = eventScope.extend({ applicationId: id }).strict();
export const extendSchema = eventScope.extend({ applicationId: id, respondBy: z.string().datetime() }).strict();
export const onBehalfSchema = eventScope.extend({ applicationId: id, response: z.enum(["accept", "decline", "withdraw"]) }).strict();

export const reviewSchema = eventScope.extend({
  assignmentId: id,
  scores: z.record(z.string().max(ADMISSION_CRITERION_MAX), z.number()),
  notes: z.string().max(ADMISSION_NOTES_MAX),
}).strict();

const token = z.string().trim().min(8).max(256);
export const respondSchema = z.object({ token, response: z.enum(["accept", "decline", "withdraw"]) }).strict();
export const answersSchema = z.object({ token, answers: z.record(z.string().max(100), z.unknown()) }).strict();
