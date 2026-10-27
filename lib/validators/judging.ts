import { z } from "zod";

// ---------------------------------------------------------------------------
// Hackathon submissions, judging, and results (docs/HACKATHON.md)
// ---------------------------------------------------------------------------

export const SUBMISSION_TITLE_MAX_LENGTH = 120;
export const SUBMISSION_SUMMARY_MAX_LENGTH = 4000;
export const SUBMISSION_URL_MAX_LENGTH = 500;
export const JUDGING_CRITERION_NAME_MAX_LENGTH = 80;
export const JUDGING_TEXT_DESCRIPTION_MAX_LENGTH = 500;
export const JUDGE_REVIEW_COMMENT_MAX_LENGTH = 2000;
export const EVENT_AWARD_NAME_MAX_LENGTH = 80;
export const DISQUALIFY_REASON_MAX_LENGTH = 500;
export const JUDGING_WEIGHT_MAX = 10;
export const JUDGING_MAX_SCORE_LIMIT = 10;
/** Upper bounds that keep one event's rubric, awards, and podiums small. */
export const JUDGING_CRITERIA_LIMIT = 20;
export const EVENT_AWARDS_LIMIT = 30;
export const EVENT_AWARD_PLACE_MAX = 20;

const judgingIdSchema = z.string().trim().min(1).max(128);
/** Control characters other than tab, line feed, and carriage return. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;

const singleLineText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !SINGLE_LINE_CONTROL.test(value), `Enter a valid ${label.toLowerCase()}`);

const plainTextBlock = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), `Enter valid ${label.toLowerCase()} text`);

/**
 * The canonical form of a project link, or null when it is not acceptable:
 * `https:` only, parsed with `URL`, no credentials, whitespace, or control
 * characters. The result is `URL.href`, so the scheme is always the literal
 * lowercase `https://` the database CHECK requires (`HTTPS://x` and
 * `https:x` both normalise), and it still fits in the length limit.
 */
export function normalizeHttpsSubmissionUrl(value: string): string | null {
  if (value.length > SUBMISSION_URL_MAX_LENGTH || /[\s\u0000-\u001F\u007F]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname.length === 0 || url.username !== "" || url.password !== "") return null;
    const href = url.href;
    return href.startsWith("https://") && href.length <= SUBMISSION_URL_MAX_LENGTH ? href : null;
  } catch {
    return null;
  }
}

/** `https:` only, parsed with `URL`; no credentials, whitespace, or control characters. */
export function isHttpsSubmissionUrl(value: string): boolean {
  return normalizeHttpsSubmissionUrl(value) !== null;
}

/** Optional project link: "" or missing clears it (null); otherwise an https URL. */
const submissionUrlSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value ?? null),
  z
    .string()
    .trim()
    .max(SUBMISSION_URL_MAX_LENGTH, `Links must be at most ${SUBMISSION_URL_MAX_LENGTH} characters`)
    .refine(isHttpsSubmissionUrl, "Use a full https:// link")
    // Store the canonical href, which always satisfies the database CHECK.
    .transform((value) => normalizeHttpsSubmissionUrl(value) ?? value)
    .nullable(),
);

/** Checkbox values from forms ("on", "true") and real booleans. */
const formBoolean = z.preprocess((value) => {
  if (value === "on" || value === "true") return true;
  if (value === "false" || value === "" || value == null) return false;
  return value;
}, z.boolean());

const optionalDate = z.preprocess(
  (value) => (value === "" || value == null ? null : value),
  z.coerce.date().nullable(),
);

/** Entrant-side project fields (draft and submit share them). */
export const submissionContentSchema = z
  .object({
    title: singleLineText("Title", SUBMISSION_TITLE_MAX_LENGTH),
    summary: plainTextBlock("Summary", SUBMISSION_SUMMARY_MAX_LENGTH).optional().default(""),
    repoUrl: submissionUrlSchema.optional().default(null),
    demoUrl: submissionUrlSchema.optional().default(null),
    videoUrl: submissionUrlSchema.optional().default(null),
  })
  .strict();
export type SubmissionContentInput = z.infer<typeof submissionContentSchema>;

/** `/submit/{token}` links carry 43-character base64url tokens. */
export const submissionTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, "Invalid link");

/**
 * A switch that may be left out: absent keeps the saved value (so a caller
 * that doesn't show it never turns it off), otherwise like `formBoolean`.
 */
const optionalFormBoolean = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (value === "on" || value === "true") return true;
  if (value === "false" || value === "" || value === null) return false;
  return value;
}, z.boolean().optional());

/** Organiser judging settings. Saving with submissions enabled needs a full window. */
export const judgingSettingsSchema = z
  .object({
    submissionsEnabled: formBoolean,
    submissionsOpenAt: optionalDate,
    submissionsCloseAt: optionalDate,
    judgesSeeAll: formBoolean,
    projectGalleryPublic: formBoolean,
    /** Hackathon emails (lib/hackathonEmails.ts); off by default, omitted keeps the saved value. */
    emailEntrantsOnResults: optionalFormBoolean,
    emailSubmissionReceipts: optionalFormBoolean,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.submissionsEnabled && (!data.submissionsOpenAt || !data.submissionsCloseAt)) {
      ctx.addIssue({ code: "custom", path: [data.submissionsOpenAt ? "submissionsCloseAt" : "submissionsOpenAt"], message: "Set when submissions open and close." });
    }
    if (data.submissionsOpenAt && data.submissionsCloseAt && data.submissionsCloseAt <= data.submissionsOpenAt) {
      ctx.addIssue({ code: "custom", path: ["submissionsCloseAt"], message: "Submissions must close after they open." });
    }
  });
export type JudgingSettingsInput = z.infer<typeof judgingSettingsSchema>;

const boundedInt = (label: string, min: number, max: number) =>
  z.coerce.number().int(`${label} must be a whole number`).min(min, `${label} must be at least ${min}`).max(max, `${label} must be at most ${max}`);

export const judgingCriterionSchema = z
  .object({
    name: singleLineText("Name", JUDGING_CRITERION_NAME_MAX_LENGTH),
    description: plainTextBlock("Description", JUDGING_TEXT_DESCRIPTION_MAX_LENGTH).optional().default(""),
    weight: boundedInt("Weight", 1, JUDGING_WEIGHT_MAX),
    maxScore: boundedInt("Maximum score", 1, JUDGING_MAX_SCORE_LIMIT),
  })
  .strict();
export type JudgingCriterionInput = z.infer<typeof judgingCriterionSchema>;

/** A full new order for the rubric or the awards (every id exactly once). */
export const judgingReorderSchema = z
  .array(judgingIdSchema)
  .min(1)
  .max(Math.max(JUDGING_CRITERIA_LIMIT, EVENT_AWARDS_LIMIT))
  .refine((ids) => new Set(ids).size === ids.length, "Each item can appear once.");

export const eventAwardSchema = z
  .object({
    name: singleLineText("Name", EVENT_AWARD_NAME_MAX_LENGTH),
    description: plainTextBlock("Description", JUDGING_TEXT_DESCRIPTION_MAX_LENGTH).optional().default(""),
  })
  .strict();
export type EventAwardInput = z.infer<typeof eventAwardSchema>;

export const awardWinnerSchema = z
  .object({
    awardId: judgingIdSchema,
    submissionId: judgingIdSchema,
    place: boundedInt("Place", 1, EVENT_AWARD_PLACE_MAX).optional().default(1),
  })
  .strict();

export const removeAwardWinnerSchema = z
  .object({ awardId: judgingIdSchema, place: boundedInt("Place", 1, EVENT_AWARD_PLACE_MAX) })
  .strict();

export const disqualifySubmissionSchema = z
  .object({
    submissionId: judgingIdSchema,
    reason: singleLineText("Reason", DISQUALIFY_REASON_MAX_LENGTH),
  })
  .strict();

export const judgeAssignmentSchema = z
  .object({ judgeUserId: judgingIdSchema, submissionId: judgingIdSchema })
  .strict();

export const judgingStatusSchema = z.enum(["NOT_STARTED", "OPEN", "CLOSED"]);

/** Which result score ranks: RAW, or ZSCORE ("Adjust for harsh/generous judges", lib/judgingScore.ts). */
export const scoreNormalizationSchema = z.enum(["RAW", "ZSCORE"]);

/** A judge's (partial) scores for one submission: whole numbers, each criterion once. */
export const judgeScoresSchema = z
  .object({
    submissionId: judgingIdSchema,
    scores: z
      .array(
        z
          .object({
            criterionId: judgingIdSchema,
            score: z.coerce.number().int("Scores are whole numbers").min(0, "Scores cannot be negative").max(JUDGING_MAX_SCORE_LIMIT),
          })
          .strict(),
      )
      .max(JUDGING_CRITERIA_LIMIT)
      .refine((rows) => new Set(rows.map((row) => row.criterionId)).size === rows.length, "Each criterion can be scored once."),
  })
  .strict();
export type JudgeScoresInput = z.infer<typeof judgeScoresSchema>;

/** The judge's private comment; `submit` marks the review complete. */
export const judgeReviewSchema = z
  .object({
    submissionId: judgingIdSchema,
    comment: plainTextBlock("Comment", JUDGE_REVIEW_COMMENT_MAX_LENGTH).optional().default(""),
    submit: z.boolean().optional().default(true),
  })
  .strict();
export type JudgeReviewInput = z.infer<typeof judgeReviewSchema>;
