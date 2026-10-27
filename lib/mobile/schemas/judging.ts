import { z } from "zod";
import { iso, judgingStatusSchema, rsvpStatusSchema, url } from "./core";

/* ---------- Teams (organiser) ---------- */

export const organiserTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: rsvpStatusSchema,
  size: z.number().int(),
  minSize: z.number().int().nullable(),
  maxSize: z.number().int().nullable(),
  /** Below the event's minimum team size; such a team cannot be approved. */
  incomplete: z.boolean(),
  lookingForMembers: z.boolean(),
  leaderDisplayName: z.string().nullable(),
  members: z.array(z.object({ rsvpId: z.string(), displayName: z.string(), isLeader: z.boolean(), checkedIn: z.boolean() }).strict()),
}).strict();

export const teamFilterCountsSchema = z.object({
  ALL: z.number().int(),
  CONFIRMED: z.number().int(),
  WAITLISTED: z.number().int(),
  PENDING_APPROVAL: z.number().int(),
  REJECTED: z.number().int(),
  INCOMPLETE: z.number().int(),
  LOOKING: z.number().int(),
}).strict();

export const teamListDtoSchema = z.object({
  teams: z.array(organiserTeamSchema),
  nextCursor: z.string().nullable(),
  counts: teamFilterCountsSchema,
}).strict();

/* ---------- Judging (judge workspace) ---------- */

export const judgingCriterionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  weight: z.number().int(),
  maxScore: z.number().int(),
}).strict();

export const myReviewStatusSchema = z.enum(["NONE", "DRAFT", "SUBMITTED"]);

/** A project as a judge sees it: content and the entrant's display name only. */
export const judgeSubmissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  links: z.object({ repo: url.nullable(), demo: url.nullable(), video: url.nullable() }).strict(),
  /** Team name, or a solo entrant's first name and last initial. */
  entrantName: z.string(),
  /** Present only for a team entrant. */
  teamName: z.string().optional(),
  myReview: z.object({ status: myReviewStatusSchema, scoredCriteria: z.number().int() }).strict(),
}).strict();

export const judgeCountsSchema = z.object({
  all: z.number().int(),
  todo: z.number().int(),
  inProgress: z.number().int(),
  reviewed: z.number().int(),
}).strict();

export const judgeSubmissionListDtoSchema = z.object({
  judgingStatus: judgingStatusSchema,
  submissions: z.array(judgeSubmissionSchema),
  nextCursor: z.string().nullable(),
  counts: judgeCountsSchema,
}).strict();

export const judgingCriteriaDtoSchema = z.object({
  judgingStatus: judgingStatusSchema,
  criteria: z.array(judgingCriterionSchema),
}).strict();

export const judgeSubmissionDetailDtoSchema = z.object({
  judgingStatus: judgingStatusSchema,
  criteria: z.array(judgingCriterionSchema),
  submission: judgeSubmissionSchema,
  myScores: z.array(z.object({ criterionId: z.string(), score: z.number().int() }).strict()),
  /** This judge's own private comment (null before one is saved). */
  myComment: z.string().nullable(),
  mySubmittedAt: iso.nullable(),
}).strict();

export const judgeNextDtoSchema = z.object({
  next: judgeSubmissionDetailDtoSchema.nullable(),
  remaining: z.number().int(),
}).strict();

export const judgeScoresSavedDtoSchema = z.object({
  scored: z.number().int(),
  total: z.number().int(),
  myReview: z.object({ status: myReviewStatusSchema, scoredCriteria: z.number().int() }).strict(),
}).strict();
