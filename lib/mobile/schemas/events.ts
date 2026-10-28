import { z } from "zod";
import { paidRsvpResultSchema, ticketingDtoSchema } from "./commerce";
import { fieldTypeSchema, iso, privacyTypeSchema, registrationModeSchema, eventStatusSchema, rsvpStatusSchema, url } from "./core";

/* ---------- Events ---------- */

export const eventSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  coverImageUrl: url.nullable(),
  startDateTime: iso,
  endDateTime: iso,
  timezone: z.string(),
  location: z.string(),
  mapLinkUrl: z.string().nullable(),
  isOnline: z.boolean(),
  accentColor: z.string().nullable(),
  status: eventStatusSchema,
  /** TEAM: capacity counts teams plus solo registrants ("teams & solo places"). */
  registrationMode: registrationModeSchema,
  organisation: z.object({ slug: z.string(), name: z.string(), logoUrl: url.nullable() }).strict(),
}).strict();

export const eventListDtoSchema = z.object({
  events: z.array(eventSummarySchema),
  nextCursor: z.string().nullable(),
}).strict();

/** The caller's own team: names only ("Ada L."), never emails, answers, tokens or links. */
export const myTeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The caller's role in the team. */
  role: z.enum(["LEADER", "MEMBER"]),
  size: z.number().int(),
  maxSize: z.number().int().nullable(),
  members: z.array(z.object({ displayName: z.string(), isLeader: z.boolean() }).strict()),
}).strict();

export const myTeamResultDtoSchema = z.object({
  team: myTeamSchema.nullable(),
  /** Space Works: the caller's order for a paid team place (PER_TEAM or PER_MEMBER tickets), if any. */
  order: z.object({ orderId: z.string(), status: z.enum(["REQUESTED", "PENDING", "CONFIRMED", "EXPIRED", "CANCELLED"]), holdExpiresAt: iso.nullable() }).strict().nullable(),
}).strict();

export const registrationDtoSchema = z.object({
  rsvpId: z.string(),
  status: rsvpStatusSchema,
  checkedInAt: iso.nullable(),
  registeredAt: iso,
  canCancel: z.boolean(),
  ticketToken: z.string().nullable(),
  /** Space Works: the paid order this registration belongs to, if any. */
  orderId: z.string().nullable(),
  /** Space Works: the caller's free crew ticket (docs/CREW.md); present only when true. */
  isCrew: z.literal(true).optional(),
  event: eventSummarySchema,
  instanceId: z.string().nullable(),
  /** Present only for a registration in a team. */
  team: myTeamSchema.optional(),
}).strict();

export const registrationsDtoSchema = z.object({
  upcoming: z.array(registrationDtoSchema),
  past: z.array(registrationDtoSchema),
  certificates: z.array(z.object({
    eventTitle: z.string(),
    organisationName: z.string(),
    issuedAt: iso,
    certificateUrl: url,
  }).strict()),
}).strict();

export const shortLinkDtoSchema = z.object({ orgSlug: z.string(), eventSlug: z.string() }).strict();

export const registrationFieldSchema = z.object({
  id: z.string(),
  key: z.string(),
  label: z.string(),
  type: fieldTypeSchema,
  required: z.boolean(),
  helpText: z.string().nullable(),
  placeholder: z.string().nullable(),
  options: z.array(z.string()),
  settings: z.object({
    minLength: z.number().int().optional(),
    maxLength: z.number().int().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    minDate: z.string().optional(),
    maxDate: z.string().optional(),
    maxSelections: z.number().int().optional(),
    allowOther: z.boolean().optional(),
  }).strict(),
  showIf: z.object({ fieldKey: z.string(), values: z.array(z.string()) }).strict().nullable(),
}).strict();

export const publicEventDtoSchema = z.object({
  event: eventSummarySchema.extend({
    description: z.string(),
    tags: z.array(z.string()),
    capacity: z.number().int().nullable(),
    showRegistrationCount: z.boolean(),
    confirmedCount: z.number().int().nullable(),
    privacyType: privacyTypeSchema,
    registrationOpen: z.boolean(),
    registrationFull: z.boolean(),
    registrationClosedReason: z.string().nullable(),
    onlineUrl: z.string().nullable(),
  }).strict(),
  registration: z.object({
    requiresApproval: z.boolean(),
    fields: z.array(registrationFieldSchema),
    myRsvp: z.object({ rsvpId: z.string(), status: rsvpStatusSchema, ticketToken: z.string().nullable() }).strict().nullable(),
  }).strict(),
  schedule: z.array(z.object({
    trackName: z.string().nullable(),
    sessions: z.array(z.object({
      id: z.string(),
      title: z.string(),
      startDateTime: iso,
      endDateTime: iso,
      delayMinutes: z.number().int(),
      room: z.string().nullable(),
      speakers: z.array(z.string()),
    }).strict()),
  }).strict()),
  speakers: z.array(z.object({ name: z.string(), title: z.string().nullable(), photoUrl: url.nullable() }).strict()),
  feedbackOpen: z.boolean(),
  /** Space Works: tickets on sale, or null for a free event. */
  ticketing: ticketingDtoSchema.nullable(),
}).strict();

export const rsvpResultDtoSchema = z.object({
  rsvpId: z.string(),
  status: z.enum(["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL"]),
  ticketToken: z.string().nullable(),
}).strict().or(paidRsvpResultSchema);

export const feedbackFormDtoSchema = z.object({
  title: z.string(),
  intro: z.string().nullable(),
  thankYouMessage: z.string(),
  open: z.literal(true),
  certificatesEnabled: z.boolean(),
  fields: z.array(registrationFieldSchema),
}).strict();
