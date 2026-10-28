import { z } from "zod";

/*
 * A mentoring round's own check-in form and its help triggers
 * (round_management.save, round_triggers.fire_locked). The question types are
 * deliberately small; none can ask a team member's date of birth or age.
 */

export const ROUND_QUESTIONS_MAX = 12;
export const ROUND_TRIGGERS_MAX = 10;
export const ROUND_TEXT_ANSWER_MAX_LENGTH = 2000;

const id = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/);

export const roundQuestionSchema = z.object({
  id,
  label: z.string().trim().min(1).max(200),
  type: z.enum(["text", "rating", "yesno", "choice"]),
  options: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  required: z.boolean().optional(),
}).strict().refine((q) => (q.type === "choice") === Boolean(q.options?.length), "Choice questions need options; others take none.");

export type RoundQuestion = z.infer<typeof roundQuestionSchema>;

export const roundFormSchema = z.array(roundQuestionSchema).max(ROUND_QUESTIONS_MAX)
  .refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length, "Question ids must be distinct.");

export const helpTriggerRuleSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9_-]{1,40}$/),
  questionId: id,
  op: z.enum(["eq", "contains"]),
  value: z.union([z.string().trim().min(1).max(80), z.boolean()]),
  categoryKey: z.string().trim().min(1).max(40),
}).strict();

export type HelpTriggerRule = z.infer<typeof helpTriggerRuleSchema>;

/** Rules must be distinct and point at existing questions and categories. */
export function validateTriggerRules(value: unknown, questions: readonly RoundQuestion[], categoryKeys: ReadonlySet<string>): HelpTriggerRule[] | null {
  const parsed = z.array(helpTriggerRuleSchema).max(ROUND_TRIGGERS_MAX).safeParse(value);
  if (!parsed.success) return null;
  const ids = new Set(questions.map((q) => q.id));
  const keys = new Set<string>();
  for (const rule of parsed.data) {
    if (keys.has(rule.key) || !ids.has(rule.questionId) || !categoryKeys.has(rule.categoryKey)) return null;
    keys.add(rule.key);
  }
  return parsed.data;
}

export type RoundAnswers = Record<string, string | number | boolean>;

/** Checks answers against the form: known ids only, typed values, required questions present. */
export function validateRoundAnswers(questions: readonly RoundQuestion[], value: unknown): RoundAnswers | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const byId = new Map(questions.map((q) => [q.id, q]));
  if (Object.keys(input).some((key) => !byId.has(key))) return null;
  const answers: RoundAnswers = {};
  for (const question of questions) {
    const raw = input[question.id];
    if (raw === undefined || raw === null || raw === "") {
      if (question.required) return null;
      continue;
    }
    if (question.type === "text") {
      if (typeof raw !== "string" || raw.length > ROUND_TEXT_ANSWER_MAX_LENGTH) return null;
      answers[question.id] = raw.trim();
    } else if (question.type === "rating") {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 5) return null;
      answers[question.id] = raw;
    } else if (question.type === "yesno") {
      if (typeof raw !== "boolean") return null;
      answers[question.id] = raw;
    } else {
      if (typeof raw !== "string" || !question.options?.includes(raw)) return null;
      answers[question.id] = raw;
    }
  }
  return answers;
}

/** The rules an answer set fires: `eq` compares exactly, `contains` matches text without case. */
export function firedTriggers(rules: readonly HelpTriggerRule[], answers: RoundAnswers): HelpTriggerRule[] {
  return rules.filter((rule) => {
    const answer = answers[rule.questionId];
    if (answer === undefined) return false;
    if (rule.op === "eq") return answer === rule.value;
    return typeof answer === "string" && typeof rule.value === "string" && answer.toLowerCase().includes(rule.value.toLowerCase());
  });
}

/** Reads a stored form, treating anything malformed as no questions. */
export function parseRoundForm(value: unknown): RoundQuestion[] {
  const parsed = roundFormSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function parseTriggerRules(value: unknown): HelpTriggerRule[] {
  const parsed = z.array(helpTriggerRuleSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}
