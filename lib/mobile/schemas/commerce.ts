import { z } from "zod";
import { iso, rsvpStatusSchema, url } from "./core";

/*
 * Space Works-only DTOs: paid tickets and orders, expense claims, hackathon
 * entries, entry fees, prizes and check-in lists. Money is sent both as a
 * formatted string (`amount`) for display and, where an app must compute, as
 * minor units in a decimal string (`…Minor`). No order access token, team
 * manage or join token, or submission link ever appears here.
 */

const money = z.string();
const minor = z.string().regex(/^-?\d+$/);

export const orderStatusSchema = z.enum(["REQUESTED", "PENDING", "CONFIRMED", "EXPIRED", "CANCELLED"]);

/* ---------- Ticketing on the public event ---------- */

export const publicTicketSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
  minPerOrder: z.number().int(),
  maxPerOrder: z.number().int(),
  sales: z.string(),
  salesStartAt: iso.nullable(),
  salesEndAt: iso.nullable(),
  remaining: z.number().int().nullable(),
  pass: z.boolean(),
  passDates: z.number().int().nullable(),
  flexible: z.boolean(),
  suggestedMinor: z.number().int().nullable(),
  maxPriceMinor: z.number().int().nullable(),
  seatsPerTicket: z.number().int(),
  feeMinor: z.number().int(),
  visibility: z.enum(["PUBLIC", "CODE", "MEMBERS"]),
  /** Can be reserved now and paid in person at the desk. */
  payAtDesk: z.boolean(),
}).strict();

export const publicAddOnSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
  maxPerOrder: z.number().int(),
  remaining: z.number().int().nullable(),
}).strict();

export const ticketingDtoSchema = z.object({
  currency: z.string(),
  tickets: z.array(publicTicketSchema),
  addOns: z.array(publicAddOnSchema),
  promoCodes: z.boolean(),
  accessCodes: z.boolean(),
  sellsPaid: z.boolean(),
  /** Paid tickets can be bought right now (the organisation's payment account works). */
  paidSalesOpen: z.boolean(),
  refundPolicy: z.string().nullable(),
}).strict();

/** A promo code's rule, for previewing the discounted total; the order is priced again when placed. */
export const promoCheckDtoSchema = z.object({
  kind: z.enum(["PERCENT", "FIXED"]),
  appliesPer: z.enum(["TICKET", "ORDER"]),
  percentOff: z.number().nullable(),
  amountOffMinor: minor.nullable(),
  ticketTypeId: z.string().nullable(),
  minQuantity: z.number().int(),
  perOrderLimit: z.number().int().nullable(),
}).strict();
export const accessCodeDtoSchema = z.object({ tickets: z.array(publicTicketSchema) }).strict();

/** The outcome of POST /rsvp for a paid registration: never a ticket until paid. */
export const paidRsvpResultSchema = z.object({
  rsvpId: z.string().nullable(),
  status: z.enum(["PENDING_PAYMENT", "PENDING_APPROVAL"]),
  ticketToken: z.null(),
  orderId: z.string(),
  /** Hosted payment page, opened in the system browser; null for a request awaiting approval. */
  checkoutUrl: url.nullable(),
  holdExpiresAt: iso.nullable(),
}).strict();

export const seriesDateSchema = z.object({
  instanceId: z.string(),
  startDateTime: iso,
  endDateTime: iso,
  capacity: z.number().int().nullable(),
  spotsLeft: z.number().int().nullable(),
  cancelled: z.boolean(),
}).strict();

/** One date of a recurring series with the tickets and passes on sale, and the series' other upcoming dates. */
export const seriesDateDtoSchema = z.object({
  series: z.object({ slug: z.string(), title: z.string(), description: z.string(), timezone: z.string(), requiresApproval: z.boolean() }).strict(),
  date: seriesDateSchema,
  registrationOpen: z.boolean(),
  /** APPROVAL_REQUIRED series take paid requests; a full date takes paid waitlist requests. */
  paidRequest: z.enum(["approval", "waitlist"]).nullable(),
  myRsvp: z.object({ rsvpId: z.string(), status: rsvpStatusSchema, ticketToken: z.string().nullable() }).strict().nullable(),
  ticketing: ticketingDtoSchema.nullable(),
  upcomingDates: z.array(seriesDateSchema),
}).strict();

/* ---------- Orders (buyer) ---------- */

export const orderSummarySchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: orderStatusSchema,
  total: money,
  totalMinor: minor,
  currency: z.string(),
  createdAt: iso,
  holdExpiresAt: iso.nullable(),
  ticketCount: z.number().int(),
  event: z.object({ title: z.string(), organisation: z.string(), startDateTime: iso.nullable() }).strict().nullable(),
}).strict();

export const orderListDtoSchema = z.object({ orders: z.array(orderSummarySchema), nextCursor: z.string().nullable() }).strict();

export const orderTicketSchema = z.object({
  rsvpId: z.string(),
  label: z.string(),
  name: z.string(),
  email: z.string(),
  account: z.boolean(),
  needsDetails: z.boolean(),
  status: rsvpStatusSchema,
  checkedIn: z.boolean(),
  /** Present only for a CONFIRMED ticket. */
  ticketToken: z.string().nullable(),
  transferUntil: iso.nullable(),
}).strict();

export const orderDetailDtoSchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: orderStatusSchema,
  testMode: z.boolean(),
  holdActive: z.boolean(),
  holdExpiresAt: iso.nullable(),
  canPay: z.boolean(),
  receiptAvailable: z.boolean(),
  total: money,
  subtotal: money,
  discount: money.nullable(),
  refunded: z.object({ amount: money, pending: z.boolean() }).strict().nullable(),
  refundPolicy: z.string().nullable(),
  /** What cancelling now returns; null when the order can't be cancelled by the buyer. */
  cancellation: z.object({ refund: money.nullable(), team: z.string().nullable() }).strict().nullable(),
  canRequestRefund: z.boolean(),
  refundRequest: z.object({ status: z.string(), note: z.string().nullable(), approved: money.nullable() }).strict().nullable(),
  free: z.boolean(),
  pass: z.boolean(),
  event: z.object({ title: z.string(), organisation: z.string(), startDateTime: iso.nullable(), timezone: z.string() }).strict().nullable(),
  lines: z.array(z.object({ id: z.string(), label: z.string(), amount: money }).strict()),
  tickets: z.array(orderTicketSchema),
}).strict();

export const checkoutDtoSchema = z.object({ checkoutUrl: url }).strict();

/* ---------- Expense claims ---------- */

export const claimSchema = z.object({
  id: z.string(),
  status: z.string(),
  category: z.string(),
  amount: money,
  approved: money.nullable(),
  note: z.string().nullable(),
}).strict();

export const participantClaimsDtoSchema = z.object({
  currency: z.string(),
  cap: money.nullable(),
  categories: z.array(z.object({ value: z.string(), label: z.string() }).strict()),
  claims: z.array(claimSchema),
}).strict();

export const staffClaimSchema = claimSchema.extend({ description: z.string(), createdAt: iso, receiptIds: z.array(z.string()) }).strict();
export const staffClaimsDtoSchema = z.object({ currency: z.string(), claims: z.array(staffClaimSchema) }).strict();

export const adminClaimSchema = staffClaimSchema.extend({
  claimant: z.string(),
  kind: z.string(),
}).strict();
export const adminClaimsDtoSchema = z.object({
  currency: z.string(),
  claims: z.array(adminClaimSchema),
  refundRequests: z.array(z.object({ id: z.string(), orderId: z.string(), reference: z.string(), buyerName: z.string(), reason: z.string(), status: z.string(), createdAt: iso }).strict()),
}).strict();

/* ---------- Hackathon entries, entry fees and prizes ---------- */

export const mySubmissionSchema = z.object({
  eventId: z.string(),
  eventTitle: z.string(),
  entrantName: z.string(),
  isTeam: z.boolean(),
  window: z.object({ opensAt: iso.nullable(), closesAt: iso.nullable(), isOpen: z.boolean() }).strict(),
  confirmed: z.boolean(),
  declined: z.boolean(),
  canEdit: z.boolean(),
  submission: z.object({
    title: z.string(), summary: z.string(), status: z.string(), submittedAt: iso.nullable(),
    links: z.object({ repo: url.nullable(), demo: url.nullable(), video: url.nullable() }).strict(),
  }).strict().nullable(),
  entryFee: z.object({ amount: money, amountMinor: minor, currency: z.string(), paid: z.boolean() }).strict().nullable(),
}).strict();

export const mySubmissionsDtoSchema = z.object({ submissions: z.array(mySubmissionSchema) }).strict();

/** A prize this person's project won. Payouts show amount and date only (no reference, note or recorder). */
export const myPrizeSchema = z.object({
  eventTitle: z.string(),
  awardName: z.string(),
  place: z.number().int(),
  projectTitle: z.string(),
  prize: money.nullable(),
  payouts: z.array(z.object({ amount: money, paidAt: iso, reversed: z.boolean() }).strict()),
}).strict();

export const myPrizesDtoSchema = z.object({ prizes: z.array(myPrizeSchema) }).strict();

/* ---------- Organiser: orders and check-in lists ---------- */

export const organiserOrderDtoSchema = z.object({
  id: z.string(),
  reference: z.string(),
  status: orderStatusSchema,
  buyerName: z.string(),
  buyerEmail: z.string(),
  total: money,
  paid: money,
  refunded: money,
  due: money,
  currency: z.string(),
  createdAt: iso,
  holdExpiresAt: iso.nullable(),
  payAtDesk: z.boolean(),
  tickets: z.array(z.object({ rsvpId: z.string(), name: z.string(), status: rsvpStatusSchema, checkedIn: z.boolean() }).strict()),
}).strict();

export const paymentInfoSchema = z.object({ due: money.nullable(), orderId: z.string().nullable(), payAtDesk: z.boolean() }).strict();

/** A crew member for the organiser (docs/CREW.md). The crew sign-up link stays on the website. */
export const crewMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.string(),
  foodPreference: z.string(),
  showOnPage: z.boolean(),
  joinedViaLink: z.boolean(),
  rsvpId: z.string(),
  checkedInAt: iso.nullable(),
}).strict();
export const crewListDtoSchema = z.object({ members: z.array(crewMemberSchema), food: z.array(z.object({ label: z.string(), count: z.number().int() }).strict()) }).strict();

export const checkInListSchema = z.object({ id: z.string(), name: z.string(), requiresEntryCheckIn: z.boolean(), checkedIn: z.number().int() }).strict();
export const checkInListsDtoSchema = z.object({ lists: z.array(checkInListSchema) }).strict();

export const listCheckInResultSchema = z.object({
  listId: z.string(),
  listName: z.string(),
  rsvpId: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: rsvpStatusSchema,
  alreadyCheckedIn: z.boolean(),
  checkedInAt: iso,
  entryCheckedInAt: iso.nullable(),
  message: z.string(),
}).strict();
