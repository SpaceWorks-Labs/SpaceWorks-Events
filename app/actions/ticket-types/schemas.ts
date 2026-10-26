import { z } from "zod";

/** An event, or a series (whose tickets, codes and policy cover its dates and passes). */
const target = {
  organisationSlug: z.string().trim().min(1).max(120),
  eventId: z.string().trim().min(1).max(128).optional(),
  seriesId: z.string().trim().min(1).max(128).optional(),
};
const oneTarget = (value: { eventId?: string; seriesId?: string; }) => Boolean(value.eventId) !== Boolean(value.seriesId);
const optionalDate = z.string().datetime().nullable().optional();
export const saveSchema = z.object({
  ...target,
  ticketTypeId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1, "Give the ticket a name.").max(80),
  description: z.string().trim().max(500).default(""),
  /** Typed price in major units, e.g. "499" or "499.50"; blank or 0 is free. */
  price: z.string().trim().max(20).default(""),
  capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
  minPerOrder: z.number().int().min(1).max(100).default(1),
  maxPerOrder: z.number().int().min(1).max(100).default(10),
  salesStartAt: optionalDate,
  salesEndAt: optionalDate,
  /** Series only, when creating: one date's ticket, or a pass for every remaining date. */
  kind: z.enum(["SINGLE", "PASS"]).default("SINGLE"),
  /** Everyone; only with an access code; or only the organisation's members. */
  visibility: z.enum(["PUBLIC", "CODE", "MEMBERS"]).default("PUBLIC"),
  /** CODE: the access code; blank keeps the current one. Stored as a digest only. */
  accessCode: z.string().trim().max(32).optional(),
  /** FLEXIBLE: pay what you want, from the price (the minimum) upwards. */
  pricing: z.enum(["FIXED", "FLEXIBLE"]).default("FIXED"),
  suggested: z.string().trim().max(20).optional(),
  maxPrice: z.string().trim().max(20).optional(),
  /** A group ticket seats this many people. */
  seatsPerTicket: z.number().int().min(1).max(20).default(1),
  /** Booking fee per ticket, paid by the buyer; blank or 0 for none. */
  fee: z.string().trim().max(20).optional(),
  /** Buyers may reserve now and pay in person. */
  payAtDesk: z.boolean().default(false),
}).strict().refine(oneTarget, "Choose an event or a series.");
export const archiveSchema = z.object({ ...target, ticketTypeId: z.string().trim().min(1).max(64) }).strict().refine(oneTarget, "Choose an event or a series.");

export const promoSchema = z.object({
  ...target,
  code: z.string().trim().min(3, "Codes are 3 to 32 letters, numbers, - or _.").max(32, "Codes are 3 to 32 letters, numbers, - or _."),
  kind: z.enum(["PERCENT", "FIXED"]),
  appliesPer: z.enum(["TICKET", "ORDER"]).default("TICKET"),
  percentOff: z.number().int().min(1).max(100).nullable().optional(),
  /** Typed amount in major units, for a fixed discount. */
  amountOff: z.string().trim().max(20).optional(),
  ticketTypeId: z.string().trim().min(1).max(64).nullable().optional(),
  minQuantity: z.number().int().min(1).max(100).default(1),
  perOrderLimit: z.number().int().min(1).max(100).nullable().optional(),
  maxRedemptions: z.number().int().min(1).max(1_000_000).nullable().optional(),
  validFrom: optionalDate,
  validUntil: optionalDate,
}).strict().refine(oneTarget, "Choose an event or a series.");
export const archivePromoSchema = z.object({ ...target, promoCodeId: z.string().trim().min(1).max(64) }).strict().refine(oneTarget, "Choose an event or a series.");

export const refundPolicySchema = z.object({
  ...target,
  kind: z.enum(["NONE", "FULL_UNTIL", "PERCENT_UNTIL"]),
  hours: z.number().int().min(0).max(8760).nullable().optional(),
  percent: z.number().int().min(1).max(99).nullable().optional(),
  text: z.string().trim().max(1000).default(""),
}).strict().refine(oneTarget, "Choose an event or a series.");

export const addOnSchema = z.object({
  ...target,
  addOnId: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1, "Give the extra a name.").max(80),
  description: z.string().trim().max(300).default(""),
  /** Typed price in major units; blank or 0 is free. */
  price: z.string().trim().max(20).default(""),
  capacity: z.number().int().min(1).max(1_000_000).nullable().optional(),
  maxPerOrder: z.number().int().min(1).max(100).default(10),
}).strict().refine(oneTarget, "Choose an event or a series.");
export const archiveAddOnSchema = z.object({ ...target, addOnId: z.string().trim().min(1).max(64) }).strict().refine(oneTarget, "Choose an event or a series.");

export const transferSchema = z.object({
  ...target,
  allowTransfers: z.boolean(),
  cutoffHours: z.number().int().min(0).max(8760).default(24),
}).strict().refine(oneTarget, "Choose an event or a series.");

/** TEAM events with tickets: everyone pays for themselves, or the leader pays once for the team. */
export const teamTicketModeSchema = z.object({
  organisationSlug: target.organisationSlug,
  eventId: z.string().trim().min(1).max(128),
  mode: z.enum(["PER_MEMBER", "PER_TEAM"]),
}).strict();
