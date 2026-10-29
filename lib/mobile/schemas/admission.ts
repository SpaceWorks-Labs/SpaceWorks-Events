import { z } from "zod";

/*
 * Applications (docs/ADMISSION.md, docs/MOBILE_API.md "Applications").
 * Applicants see their own application only; reviewers see what their stage
 * allows (a blind stage: no names, emails, phone numbers or team names);
 * organisers see counts. Never reviews to applicants, never scores of other
 * reviewers, never a ticket token.
 */

const iso = z.string().datetime();
export const admissionStatusSchema = z.enum(["IN_REVIEW", "OFFERED", "WAITLISTED", "ACCEPTED", "REJECTED", "DECLINED", "EXPIRED", "WITHDRAWN"]);
const fieldTypeSchema = z.enum(["TEXT", "TEXTAREA", "EMAIL", "PHONE", "SELECT", "MULTI_SELECT", "RADIO", "CHECKBOX", "NUMBER", "DATE"]);

export const myApplicationSchema = z.object({
  status: admissionStatusSchema,
  statusLabel: z.string(),
  /** While in review: the stage it is reviewed in. */
  stage: z.object({ name: z.string(), position: z.number().int() }).strict().nullable(),
  /** While offered: answer by then. */
  respondBy: iso.nullable(),
  teamName: z.string().nullable(),
  /** Solo applicant or team leader: answers the offer and withdraws. */
  isLeader: z.boolean(),
  /** What the caller may send to POST .../application/respond now. */
  actions: z.array(z.enum(["accept", "decline", "withdraw"])),
  /** Accepting costs money: the place is held while it is paid and confirmed once paid. */
  paid: z.boolean(),
  /** A payment for this place is in progress (its hold is live). */
  paying: z.boolean(),
  /** The caller's answers, editable with PUT .../application/answers until the first decision; null when not editable. */
  answers: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: fieldTypeSchema,
    required: z.boolean(),
    options: z.array(z.string()),
    value: z.string(),
    values: z.array(z.string()),
  }).strict()).nullable(),
}).strict();

export const myApplicationDtoSchema = z.object({ application: myApplicationSchema.nullable() }).strict();

export const applicationRespondDtoSchema = z.object({
  status: admissionStatusSchema,
  paying: z.boolean(),
  /** A paid acceptance: the hosted payment page (open it in the system browser, then poll GET .../application). */
  checkoutUrl: z.string().url().nullable(),
}).strict();

export const reviewQueueItemSchema = z.object({
  assignmentId: z.string(),
  stageName: z.string(),
  stagePosition: z.number().int(),
  stageOpen: z.boolean(),
  /** The applicant or team name; "Application n" on a blind stage. */
  label: z.string(),
  status: z.enum(["ASSIGNED", "SUBMITTED", "RECUSED"]),
  reviewedCurrent: z.boolean(),
}).strict();

export const reviewQueueDtoSchema = z.object({ reviews: z.array(reviewQueueItemSchema) }).strict();

export const reviewItemDtoSchema = z.object({
  assignmentId: z.string(),
  /** The answers shown; send it back with the review (changed answers are refused). */
  answersRevision: z.number().int(),
  stageName: z.string(),
  stageOpen: z.boolean(),
  blind: z.boolean(),
  criteria: z.array(z.string()),
  guidance: z.string(),
  teamName: z.string().nullable(),
  people: z.array(z.object({
    name: z.string(),
    /** Null on a blind stage. */
    email: z.string().nullable(),
    isLeader: z.boolean(),
    answers: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
  }).strict()),
  /** The caller's own review of the current answers, if submitted. */
  reviewed: z.object({ scores: z.record(z.string(), z.number().int()), notes: z.string() }).strict().nullable(),
  canReview: z.boolean(),
}).strict();

export const reviewWriteDtoSchema = z.object({
  assignmentId: z.string(),
  outcome: z.enum(["SUBMITTED", "RECUSED"]),
  /** Recusal only: someone else on the stage's panel took the application. */
  replaced: z.boolean().nullable(),
}).strict();

const statusCountsSchema = z.object(Object.fromEntries(admissionStatusSchema.options.map((status) => [status, z.number().int()])) as Record<z.infer<typeof admissionStatusSchema>, z.ZodNumber>).strict();

export const applicationCountsSchema = z.object({
  total: z.number().int(),
  byStatus: statusCountsSchema,
  /** Offered plus accepted, against the offer limit (the offer capacity, else the event capacity, else none). */
  offersOut: z.number().int(),
  offersLimit: z.number().int().nullable(),
}).strict();

export const applicationsSummaryDtoSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["MANUAL", "AUTO"]),
  counts: applicationCountsSchema,
  stages: z.array(z.object({ position: z.number().int(), name: z.string(), status: z.enum(["DRAFT", "OPEN", "CLOSED"]), reached: z.number().int(), inReview: z.number().int() }).strict()),
  /** Waitlisted applications in queue order: how many, and how many were last passed over. */
  waitlist: z.object({ queued: z.number().int(), passedOver: z.number().int() }).strict(),
  draftedDecisions: z.number().int(),
}).strict();
