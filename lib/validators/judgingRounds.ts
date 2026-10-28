import { z } from "zod";

// ---------------------------------------------------------------------------
// Judging rounds and finalist advancement (docs/HACKATHON.md "Rounds")
// ---------------------------------------------------------------------------

export const JUDGING_ROUND_NAME_MAX_LENGTH = 80;
/** Rounds per event: a qualifier, semi-finals and a final leave plenty of room. */
export const JUDGING_ROUNDS_LIMIT = 10;
/** Finalists advanced in one go (and the size of a hand-picked list). */
export const FINALISTS_LIMIT = 500;

const SINGLE_LINE_CONTROL = /[\u0000-\u001F\u007F]/;
const idSchema = z.string().trim().min(1).max(128);

const roundName = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(JUDGING_ROUND_NAME_MAX_LENGTH, `Name must be at most ${JUDGING_ROUND_NAME_MAX_LENGTH} characters`)
  .refine((value) => !SINGLE_LINE_CONTROL.test(value), "Enter a valid name");

const optionalDate = z.preprocess((value) => (value === "" || value == null ? null : value), z.coerce.date().nullable());
const formBoolean = z.preprocess((value) => (value === "on" || value === "true" ? true : value === "false" || value === "" || value == null ? false : value), z.boolean());
const optionalTarget = z.preprocess(
  (value) => (value === "" || value == null ? null : value),
  z.coerce.number().int("Choose a whole number").min(1, "Choose between 1 and 20 judges per project.").max(20, "Choose between 1 and 20 judges per project.").nullable(),
);

/** A round's settings, as the Rounds editor sends them. */
export const judgingRoundSchema = z
  .object({
    name: roundName,
    entrySource: z.enum(["ALL_SUBMITTED", "ADVANCED"]),
    judgesSeeAll: formBoolean,
    /** A judge never sees or gets a project they reviewed in an earlier round. */
    freshEyes: formBoolean,
    reviewsPerProject: optionalTarget,
    scoreNormalization: z.enum(["RAW", "ZSCORE"]),
    opensAt: optionalDate,
    closesAt: optionalDate,
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.opensAt && data.closesAt && data.closesAt <= data.opensAt) {
      ctx.addIssue({ code: "custom", path: ["closesAt"], message: "The round must close after it opens." });
    }
  });
export type JudgingRoundInput = z.infer<typeof judgingRoundSchema>;

export const judgingRoundOrderSchema = z
  .array(idSchema)
  .min(1)
  .max(JUDGING_ROUNDS_LIMIT)
  .refine((ids) => new Set(ids).size === ids.length, "Each round can appear once.");

export const judgingRoundPanelSchema = z
  .array(idSchema)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, "Each judge can appear once.");

/**
 * Which projects advance into a round: the top `count` of the previous
 * round's ranking, or a hand-picked list. `fingerprint` (apply only) is the
 * preview's, so a changed plan is refused.
 */
export const advanceFinalistsSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("top"), count: z.coerce.number().int().min(1, "Advance at least one project.").max(FINALISTS_LIMIT), fingerprint: z.string().max(128).optional() }).strict(),
    z.object({ mode: z.literal("pick"), submissionIds: z.array(idSchema).min(1, "Pick at least one project.").max(FINALISTS_LIMIT), fingerprint: z.string().max(128).optional() }).strict(),
  ]);
export type AdvanceFinalistsInput = z.infer<typeof advanceFinalistsSchema>;
