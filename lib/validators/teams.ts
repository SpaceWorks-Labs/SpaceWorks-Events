import { RegistrationMode, SoloPolicy } from "@prisma/client";
import { z } from "zod";
import { attendeeNameSchema, orgScoped } from "@/lib/validators/shared";

/** Upper bound for `teamMaxSize`; keeps a single unit from swallowing an event. */
export const TEAM_MAX_SIZE_LIMIT = 100;
export const TEAM_NAME_MAX_LENGTH = 60;
export const SEEKER_HEADLINE_MAX_LENGTH = 120;
export const SEEKER_MAX_SKILLS = 8;
export const SEEKER_SKILL_MAX_LENGTH = 30;

const emptyToUndefined = (value: unknown) =>
  value === "" || value === null ? undefined : value;

const optionalTeamSize = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}, z.number().int("Team size must be a whole number").min(1).max(TEAM_MAX_SIZE_LIMIT).optional());

/**
 * Team registration settings shared by the one-off event create and update
 * schemas. On update every field is optional: an omitted `registrationMode`
 * leaves all four settings untouched, so older forms cannot reset them.
 */
export const teamSettingsFields = {
  registrationMode: z.preprocess(emptyToUndefined, z.nativeEnum(RegistrationMode).optional()),
  teamMinSize: optionalTeamSize,
  teamMaxSize: optionalTeamSize,
  soloPolicy: z.preprocess(emptyToUndefined, z.nativeEnum(SoloPolicy).optional()),
};

export function validateTeamSettings(
  data: { registrationMode?: RegistrationMode; teamMinSize?: number; teamMaxSize?: number },
  ctx: z.RefinementCtx,
) {
  if (data.registrationMode !== RegistrationMode.TEAM) return;
  if (data.teamMaxSize == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teamMaxSize"], message: "Set a maximum team size." });
    return;
  }
  if (data.teamMaxSize < 2) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teamMaxSize"], message: "Teams need room for at least 2 people." });
  }
  if (data.teamMinSize != null && data.teamMinSize > data.teamMaxSize) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["teamMinSize"], message: "Minimum team size cannot be above the maximum." });
  }
}

/**
 * The stored team settings for a validated create/update payload. INDIVIDUAL
 * events keep no sizes; `null` means "leave the settings unchanged".
 */
export function normalizedTeamSettings(data: {
  registrationMode?: RegistrationMode;
  teamMinSize?: number;
  teamMaxSize?: number;
  soloPolicy?: SoloPolicy;
}): { registrationMode: RegistrationMode; teamMinSize: number | null; teamMaxSize: number | null; soloPolicy: SoloPolicy } | null {
  if (data.registrationMode === undefined) return null;
  if (data.registrationMode === RegistrationMode.INDIVIDUAL) {
    return { registrationMode: RegistrationMode.INDIVIDUAL, teamMinSize: null, teamMaxSize: null, soloPolicy: SoloPolicy.SOLO_ALLOWED };
  }
  return {
    registrationMode: RegistrationMode.TEAM,
    teamMinSize: data.teamMinSize ?? null,
    teamMaxSize: data.teamMaxSize ?? null,
    soloPolicy: data.soloPolicy ?? SoloPolicy.SOLO_ALLOWED,
  };
}

const seriesTeamMessage = "Team registration is only available for one-off events.";
const refusedForSeries = z.preprocess(
  emptyToUndefined,
  z.undefined({ error: seriesTeamMessage }),
);

/** Recurring series stay individual: any team setting is refused, not ignored. */
export const seriesTeamSettingsRefusal = {
  registrationMode: z.preprocess(
    emptyToUndefined,
    z.literal(RegistrationMode.INDIVIDUAL, { error: seriesTeamMessage }).optional(),
  ),
  teamMinSize: refusedForSeries,
  teamMaxSize: refusedForSeries,
  soloPolicy: refusedForSeries,
};

function isValidTeamName(value: string) {
  return /[\p{L}\p{N}]/u.test(value) && !/[<>\u0000-\u001F\u007F]/.test(value);
}

export const teamNameSchema = z
  .string()
  .trim()
  .min(1, "Team name is required")
  .max(TEAM_NAME_MAX_LENGTH, `Team name must be at most ${TEAM_NAME_MAX_LENGTH} characters`)
  .transform((value) => value.replace(/\s+/g, " "))
  .refine(isValidTeamName, "Enter a valid team name");

/** Case- and spacing-insensitive key behind the per-event unique team name. */
export function teamNameKey(name: string) {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Join links and management links carry 43-character base64url tokens. */
export const teamTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, "Invalid link");

/** Shape of an RSVP check-in (ticket) token, as validated by the ticket page. */
export const ticketTokenSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{8,128}$/, "Invalid ticket");

const seekerSkillsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(SEEKER_SKILL_MAX_LENGTH, `Each skill must be at most ${SEEKER_SKILL_MAX_LENGTH} characters`)
      .refine((value) => !/[<>\u0000-\u001F\u007F]/.test(value), "Enter a valid skill"),
  )
  .max(SEEKER_MAX_SKILLS, `Add up to ${SEEKER_MAX_SKILLS} skills`)
  .transform((skills) => {
    const seen = new Set<string>();
    return skills.filter((skill) => {
      const key = skill.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

/** "Looking for a team" profile fields (headline and skills). */
export const seekerProfileFieldsSchema = z
  .object({
    headline: z
      .string()
      .trim()
      .min(1, "Add a short headline")
      .max(SEEKER_HEADLINE_MAX_LENGTH, `Keep the headline under ${SEEKER_HEADLINE_MAX_LENGTH} characters`)
      .refine((value) => !/[<>\u0000-\u001F\u007F]/.test(value), "Enter a valid headline"),
    skills: seekerSkillsSchema.optional().default([]),
  })
  .strict();

/**
 * How a registration on a TEAM event is made. Parsed separately from the RSVP
 * body by the web registration route and passed to `submitRsvpCore` in its
 * options, so API clients that only send the RSVP body always register solo.
 */
export const teamRegistrationIntentSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), name: teamNameSchema }).strict(),
  z.object({ mode: z.literal("join"), joinToken: teamTokenSchema }).strict(),
  z.object({ mode: z.literal("solo"), seeker: seekerProfileFieldsSchema.optional() }).strict(),
]);
export type TeamRegistrationIntent = z.infer<typeof teamRegistrationIntentSchema>;

/** Leader adds a member by name and email from the team page. */
export const addTeamMemberSchema = z
  .object({
    name: attendeeNameSchema,
    email: z.string().trim().email("Valid email required").max(320),
  })
  .strict();

/** Seeker profile edit from the ticket page (ticket token proves ownership). */
export const upsertSeekerProfileSchema = seekerProfileFieldsSchema.extend({
  visible: z.boolean().optional().default(true),
});

export const renameTeamSchema = z.object({ name: teamNameSchema }).strict();

/** Organiser action on a whole team (approve, reject, promote, delete). */
export const organiserTeamActionSchema = orgScoped
  .extend({
    eventId: z.string().trim().min(1).max(128),
    teamId: z.string().trim().min(1).max(128),
  })
  .strict();

export const organiserRenameTeamSchema = organiserTeamActionSchema.extend({
  name: teamNameSchema,
});

/** Move one registration into another team of the same event. */
export const organiserMoveTeamMemberSchema = orgScoped
  .extend({
    eventId: z.string().trim().min(1).max(128),
    rsvpId: z.string().trim().min(1).max(128),
    targetTeamId: z.string().trim().min(1).max(128),
  })
  .strict();
