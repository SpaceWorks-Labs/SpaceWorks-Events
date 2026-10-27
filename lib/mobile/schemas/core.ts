import { z } from "zod";

/*
 * Response DTOs for /api/mobile/v1 (the Space Works mobile apps). Every route parses its payload through
 * one of these strict schemas before responding, so an unexpected field (a
 * password hash, MFA secret, someone else's ticket token) fails loudly instead
 * of being serialized. docs/mobile-api.openapi.yaml and the fixtures in
 * docs/mobile-api-fixtures/ are tested against these schemas.
 */

export const iso = z.string().datetime();
export const url = z.string().url();

/** PENDING_PAYMENT: a paid place held while the buyer pays; never a ticket until paid. */
export const rsvpStatusSchema = z.enum(["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL", "REJECTED", "PENDING_PAYMENT"]);
export const eventStatusSchema = z.enum(["DRAFT", "PUBLISHED", "HIDDEN", "CANCELLED"]);
export const privacyTypeSchema = z.enum(["PUBLIC", "HIDDEN_LINK", "APPROVAL_REQUIRED", "INVITE_ONLY"]);
export const membershipRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);
export const eventPermissionSchema = z.enum(["EDIT_DETAILS", "MANAGE_REGISTRATIONS", "MANAGE_INVITATIONS", "CHECK_IN", "PUBLISH_AND_SCHEDULE", "JUDGE"]);
export const fieldTypeSchema = z.enum(["TEXT", "TEXTAREA", "EMAIL", "PHONE", "SELECT", "MULTI_SELECT", "RADIO", "CHECKBOX", "NUMBER", "DATE"]);
export const attendanceSchema = z.enum(["ANY", "CHECKED_IN", "NOT_CHECKED_IN"]);
export const registrationModeSchema = z.enum(["INDIVIDUAL", "TEAM"]);
export const judgingStatusSchema = z.enum(["NOT_STARTED", "OPEN", "CLOSED"]);

/** Every error code a mobile response can carry (lib/mobile/http.ts). */
export const mobileErrorCodeSchema = z.enum([
  "INVALID_REQUEST", "UNAUTHENTICATED", "MFA_REQUIRED", "EMAIL_VERIFICATION_REQUIRED", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
  "NEEDS_FORCE", "RATE_LIMITED", "TEAM_REQUIRED", "TEAM_MEMBER", "TEAM_INCOMPLETE", "CAPACITY_FULL", "JUDGING_CLOSED",
  "INCOMPLETE_SCORES", "NOT_VISIBLE", "INTERNAL_ERROR",
  // Space Works additions: staff authenticator, sign-in protections, payments.
  "STAFF_MFA_REQUIRED", "STAFF_MFA_ENROLMENT_REQUIRED", "EMAIL_CODE_REQUIRED", "TOO_MANY_ATTEMPTS", "REAUTH_REQUIRED",
  "PAID_ORDER", "REGISTRATION_CLOSED", "PAYMENT_UNAVAILABLE",
]);

export const errorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: mobileErrorCodeSchema,
    message: z.string(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
  }).strict(),
}).strict();

export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({ ok: z.literal(true), data }).strict();
}

/* ---------- Auth and account ---------- */

export const userDtoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  imageUrl: url.nullable(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean(),
}).strict();

export const sessionDtoSchema = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: iso,
  refreshToken: z.string(),
  refreshTokenExpiresAt: iso,
  user: userDtoSchema,
}).strict();

export const authConfigDtoSchema = z.object({
  instanceName: z.string(),
  googleSignIn: z.object({ enabled: z.boolean(), webClientId: z.string().nullable() }).strict(),
  signupEnabled: z.boolean(),
  /** Paid tickets are switched on for this instance. */
  paidEventsEnabled: z.boolean(),
  baseUrl: url,
}).strict();

export const orgSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  logoUrl: url.nullable(),
  role: membershipRoleSchema,
}).strict();

export const collaborationSchema = z.object({
  organisation: z.object({ slug: z.string(), name: z.string() }).strict(),
  eventId: z.string(),
  eventTitle: z.string(),
  permissions: z.array(eventPermissionSchema),
}).strict();

/** An event the caller can judge through a JUDGE grant (organisation admins use `myPermissions.judge` on the org event list instead). */
export const judgingEventSchema = z.object({
  organisation: z.object({ slug: z.string(), name: z.string() }).strict(),
  eventId: z.string(),
  eventTitle: z.string(),
  startDateTime: iso,
  endDateTime: iso,
  timezone: z.string(),
  judgingStatus: judgingStatusSchema,
}).strict();

export const meDtoSchema = z.object({
  user: userDtoSchema,
  organisations: z.array(orgSummarySchema),
  collaborations: z.array(collaborationSchema),
  judging: z.array(judgingEventSchema),
  /**
   * The staff authenticator rule for this app session: "ok", "verify" (POST
   * /auth/mfa with a code) or "enrol" (set an authenticator up on the website;
   * that signs the app out). Attendees are always "ok".
   */
  staffMfa: z.enum(["ok", "verify", "enrol"]),
}).strict();
