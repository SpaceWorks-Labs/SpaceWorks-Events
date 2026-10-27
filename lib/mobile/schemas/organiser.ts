import { z } from "zod";
import { attendanceSchema, iso, privacyTypeSchema, rsvpStatusSchema, url } from "./core";
import { eventSummarySchema } from "./events";
import { paymentInfoSchema } from "./commerce";

/* ---------- Organiser ---------- */

export const eventPermissionsSchema = z.object({
  checkIn: z.boolean(),
  manageRegistrations: z.boolean(),
  sendEmails: z.boolean(),
  schedule: z.boolean(),
  manageFeedback: z.boolean(),
  manageRegistrationWindow: z.boolean(),
  /** Can open the judging workspace: OWNER/ADMIN or the JUDGE grant, on an event with submissions switched on. */
  judge: z.boolean(),
  /** Space Works: custom check-in lists (CHECK_IN). */
  checkInToLists: z.boolean(),
  /** Space Works: paid orders, desk settlement, payment links and refunds (MANAGE_REGISTRATIONS). */
  manageOrders: z.boolean(),
  /** Space Works: file and withdraw own expense claims (anyone on the event dashboard). */
  fileClaims: z.boolean(),
  /** Space Works: decide claims and refund requests (organisation OWNER/ADMIN). */
  manageFinance: z.boolean(),
}).strict();

export const eventCountsSchema = z.object({
  confirmed: z.number().int(),
  waitlisted: z.number().int(),
  pending: z.number().int(),
  /** Space Works: paid places held while the buyer pays (they count against capacity). */
  pendingPayment: z.number().int(),
  checkedIn: z.number().int(),
  capacity: z.number().int().nullable(),
  /** What `capacity` is compared with: confirmed RSVPs, or on TEAM events confirmed teams plus solo registrants. */
  capacityUsed: z.number().int(),
}).strict();

export const orgEventsDtoSchema = z.object({
  events: z.array(eventSummarySchema.extend({
    counts: eventCountsSchema.nullable(),
    myPermissions: eventPermissionsSchema,
  }).strict()),
}).strict();

export const orgEventDetailDtoSchema = z.object({
  event: eventSummarySchema.extend({
    privacyType: privacyTypeSchema,
    registrationOpen: z.boolean(),
    registrationClosesAt: iso.nullable(),
    registrationClosedReason: z.string().nullable(),
    registrationManuallyClosed: z.boolean(),
    feedbackOpen: z.boolean(),
    eventUrl: url,
    shortUrl: url.nullable(),
  }).strict(),
  counts: eventCountsSchema.nullable(),
  myPermissions: eventPermissionsSchema,
}).strict();

export const guestSchema = z.object({
  rsvpId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: rsvpStatusSchema,
  checkedInAt: iso.nullable(),
  registeredAt: iso,
  isGuest: z.boolean(),
  /** TEAM events: the guest's team; absent for solo registrants and individual events. */
  teamName: z.string().optional(),
  /** Space Works: the paid order this guest's ticket belongs to (GET orders/:orderId). */
  orderId: z.string().optional(),
  /**
   * Space Works, only in answers to approve, promote, reaccept and reject:
   * LINK_SENT (a paid place was offered; the ticket confirms once paid) or
   * REFUNDED (a declined paid order was refunded).
   */
  paymentOutcome: z.enum(["LINK_SENT", "REFUNDED"]).optional(),
}).strict();

const detailSchema = z.object({ label: z.string(), value: z.string() }).strict();

export const guestListDtoSchema = z.object({ guests: z.array(guestSchema), nextCursor: z.string().nullable() }).strict();
export const guestDetailDtoSchema = guestSchema.extend({ answers: z.array(detailSchema) }).strict();
export const undoDtoSchema = z.object({ undoId: z.string() }).strict();

export const checkInResultSchema = z.object({
  rsvpId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: rsvpStatusSchema,
  alreadyCheckedIn: z.boolean(),
  checkedInAt: iso.nullable(),
  checkInDetails: z.array(detailSchema),
  registrationDetails: z.array(detailSchema),
  /** TEAM events: the attendee's team; absent for solo registrants. */
  teamName: z.string().optional(),
}).strict();

export const checkInPreviewSchema = checkInResultSchema.extend({
  /** Space Works: money still owed on this guest's order (pay at the desk). */
  payment: paymentInfoSchema.nullable(),
  gate: z.union([
    z.object({ ok: z.literal(true) }).strict(),
    z.object({ ok: z.literal(false), reason: z.string(), needsForce: z.boolean(), blocked: z.boolean().optional() }).strict(),
  ]),
}).strict();

export const lookupDtoSchema = z.object({ rows: z.array(guestSchema) }).strict();

export const checkInStatsDtoSchema = z.object({
  confirmed: z.number().int(),
  checkedIn: z.number().int(),
  recent: z.array(z.object({ rsvpId: z.string(), displayName: z.string(), checkedInAt: iso }).strict()),
}).strict();

export const rosterDtoSchema = z.object({
  generatedAt: iso,
  rows: z.array(guestSchema.extend({
    ticketToken: z.string(),
    checkInDetails: z.array(detailSchema),
    registrationDetails: z.array(detailSchema),
  }).strict()),
}).strict();

export const syncDtoSchema = z.object({
  syncedIds: z.array(z.string()),
  alreadyCheckedInIds: z.array(z.string()),
  failed: z.array(z.object({ rsvpId: z.string(), error: z.string() }).strict()),
}).strict();

export const broadcastsMetaDtoSchema = z.object({
  templates: z.array(z.object({
    id: z.string(),
    group: z.string(),
    name: z.string(),
    description: z.string(),
    subject: z.string(),
    bodyHtml: z.string(),
    audience: z.object({ statuses: z.array(rsvpStatusSchema), attendance: attendanceSchema }).strict(),
  }).strict()),
  designs: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() }).strict()),
  placeholders: z.array(z.string()),
  history: z.array(z.object({
    id: z.string(),
    subject: z.string(),
    design: z.string(),
    audience: z.object({ statuses: z.array(rsvpStatusSchema), attendance: attendanceSchema }).strict(),
    recipientCount: z.number().int(),
    sentAt: iso,
    bodyHtml: z.string(),
  }).strict()),
}).strict();

export const broadcastCountDtoSchema = z.object({ count: z.number().int() }).strict();
export const broadcastPreviewDtoSchema = z.object({ subject: z.string(), html: z.string(), text: z.string() }).strict();
export const broadcastTestDtoSchema = z.object({ to: z.string() }).strict();
export const broadcastSendDtoSchema = z.object({ broadcastId: z.string(), recipientCount: z.number().int() }).strict();

export const scheduleSpeakerSchema = z.object({
  id: z.string(),
  name: z.string(),
  headline: z.string().nullable(),
  organisation: z.string().nullable(),
  photoUrl: z.string().nullable(),
}).strict();

export const scheduleDtoSchema = z.object({
  generatedAt: iso,
  tracks: z.array(z.object({
    id: z.string().nullable(),
    name: z.string(),
    sessions: z.array(z.object({
      id: z.string(),
      title: z.string(),
      type: z.string(),
      visibility: z.enum(["DRAFT", "PUBLISHED", "HIDDEN"]),
      startDateTime: iso,
      endDateTime: iso,
      delayMinutes: z.number().int(),
      /** Planned times shifted by the delays of earlier sessions in the track, as on the public page. */
      effectiveStartDateTime: iso,
      effectiveEndDateTime: iso,
      speakers: z.array(scheduleSpeakerSchema),
    }).strict()),
  }).strict()),
}).strict();

export const feedbackStateDtoSchema = z.object({ open: z.boolean() }).strict();
export const registrationStateDtoSchema = z.object({
  registrationOpen: z.boolean(),
  registrationClosesAt: iso.nullable(),
  registrationClosedReason: z.string().nullable(),
  registrationManuallyClosed: z.boolean(),
}).strict();
