// Mirrors lib/validators.ts; the client bundle must not import server validators.
const SEEKER_HEADLINE_MAX_LENGTH = 120;
const SEEKER_MAX_SKILLS = 8;
const SEEKER_SKILL_MAX_LENGTH = 30;
const UNSAFE_TEXT = /[<>\u0000-\u001F\u007F]/;

export function parseSkills(value: string) {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

/** Field messages before the request; the server still decides. */
export function seekerProfileErrors(headline: string, skills: string[]) {
  const errors: Record<string, string[]> = {};
  const line = headline.trim();
  if (!line) errors.headline = ["Add a short headline so teams know what you bring."];
  else if (line.length > SEEKER_HEADLINE_MAX_LENGTH) errors.headline = [`Keep the headline to ${SEEKER_HEADLINE_MAX_LENGTH} characters.`];
  else if (UNSAFE_TEXT.test(line)) errors.headline = ["Remove the < and > characters from the headline."];
  if (skills.length > SEEKER_MAX_SKILLS) errors.skills = [`Add up to ${SEEKER_MAX_SKILLS} skills.`];
  else if (skills.some((skill) => skill.length > SEEKER_SKILL_MAX_LENGTH)) errors.skills = [`Keep each skill to ${SEEKER_SKILL_MAX_LENGTH} characters.`];
  else if (skills.some((skill) => UNSAFE_TEXT.test(skill))) errors.skills = ["Remove the < and > characters from your skills."];
  return errors;
}

/**
 * Server field errors keyed for this form: Zod reports one skill's problem as
 * `skills.N`, which is shown on the Skills field.
 */
export function profileFieldErrors(fieldErrors: Record<string, string[]> | undefined) {
  const errors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(fieldErrors ?? {})) {
    const field = key === "skills" || key.startsWith("skills.") ? "skills" : key;
    if (field !== "headline" && field !== "skills") continue;
    errors[field] = [...(errors[field] ?? []), ...messages];
  }
  return errors;
}
