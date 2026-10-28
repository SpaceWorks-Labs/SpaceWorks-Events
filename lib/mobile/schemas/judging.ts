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

/** A judging round as the judge workspace names it (docs/HACKATHON.md "Rounds"). */
export const judgeRoundSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  judgingStatus: judgingStatusSchema,
  /** The round judges score now; scores and reviews are written only to it. */
  isCurrent: z.boolean(),
}).strict();

export const judgeRoundsDtoSchema = z.object({
  rounds: z.array(judgeRoundSchema),
  currentRoundId: z.string().nullable(),
  /** False when the current round has its own panel and this judge is not on it. */
  onPanel: z.boolean(),
}).strict();

export const judgeSubmissionListDtoSchema = z.object({
  judgingStatus: judgingStatusSchema,
  /** The round shown (null before the event has any round). */
  round: judgeRoundSchema.nullable(),
  submissions: z.array(judgeSubmissionSchema),
  nextCursor: z.string().nullable(),
  counts: judgeCountsSchema,
}).strict();

export const judgingCriteriaDtoSchema = z.object({
  judgingStatus: judgingStatusSchema,
  round: judgeRoundSchema.nullable(),
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

/** Judging → Rounds for organisers, read-only. */
export const judgingRoundsSummaryDtoSchema = z.object({
  rounds: z.array(z.object({
    id: z.string(), name: z.string(), position: z.number().int(),
    status: z.enum(["DRAFT", "OPEN", "CLOSED"]), entrySource: z.enum(["ALL_SUBMITTED", "ADVANCED"]),
    judgesSeeAll: z.boolean(), freshEyes: z.boolean(), reviewsPerProject: z.number().int().nullable(),
    opensAt: iso.nullable(), closesAt: iso.nullable(), finalistsPublishedAt: iso.nullable(), finalizedAt: iso.nullable(),
    isCurrent: z.boolean(), isFinal: z.boolean(), panelSize: z.number().int(), criteria: z.number().int(),
    finalists: z.number().int(), reviewsSubmitted: z.number().int(),
  }).strict()),
}).strict();

/** Published finalists for the public results (titles, entrant names, links; never scores). */
export const publicFinalistsDtoSchema = z.object({
  rounds: z.array(z.object({
    roundName: z.string(),
    publishedAt: iso,
    finalists: z.array(z.object({
      title: z.string(), entrantName: z.string(), isTeam: z.boolean(),
      links: z.object({ repo: url.nullable(), demo: url.nullable(), video: url.nullable() }).strict(),
    }).strict()),
  }).strict()),
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
