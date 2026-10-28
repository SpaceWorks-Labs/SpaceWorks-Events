import { z } from "zod";
import { iso } from "./core";

/* ---------- Reimbursement policies (docs/FINANCE.md "Reimbursement policies") ---------- */

const money = z.string();
const categoryOption = z.object({ value: z.string(), label: z.string() }).strict();

/** A policy open to the caller's registration now, with what is left for them. */
export const reimbursementOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  who: z.string(),
  cap: money,
  left: money,
  categories: z.array(categoryOption),
  claimClosesAt: iso.nullable(),
}).strict();

export const myReimbursementsDtoSchema = z.object({
  currency: z.string(),
  /** The event's general claims (no policy), when open to this registration. */
  general: z.object({ cap: money.nullable() }).strict().nullable(),
  policies: z.array(reimbursementOptionSchema),
}).strict();

export const organiserPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  eligibility: z.string(),
  who: z.string(),
  cap: money,
  categories: z.array(z.string()),
  budget: money.nullable(),
  used: money,
  budgetLeft: money.nullable(),
  claimOpensAt: iso.nullable(),
  claimClosesAt: iso.nullable(),
  window: z.enum(["upcoming", "open", "closed"]),
  attendanceRequired: z.boolean(),
  active: z.boolean(),
  claims: z.number().int(),
}).strict();

export const reimbursementPoliciesDtoSchema = z.object({ currency: z.string(), policies: z.array(organiserPolicySchema) }).strict();
