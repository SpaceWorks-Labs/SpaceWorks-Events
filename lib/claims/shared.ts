import "server-only";

import { ExpenseCategory, OfflinePaymentMethod, type Prisma } from "@prisma/client";
import { z } from "zod";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { DEFAULT_CURRENCY } from "@/lib/payments/money";
import { deleteReceipts, newReceiptKey, uploadReceipt } from "@/lib/storage/private";

/** Shared rules for expense claims (docs/FINANCE.md). */

export type ClaimResult<T = undefined> = { ok: true; data: T; } | { ok: false; error: string; };
export const ok = <T>(data: T): ClaimResult<T> => ({ ok: true, data });
export const fail = (error: string): { ok: false; error: string; } => ({ ok: false, error });

export const MAX_RECEIPTS = 3;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

const id = z.string().trim().min(1).max(128);
export const claimFieldsSchema = z.object({
  category: z.nativeEnum(ExpenseCategory),
  description: z.string().trim().min(1, "Say what the money was spent on.").max(1000),
  amount: z.string().trim().min(1, "Enter the amount.").max(20),
}).strict();
/** A participant's or crew member's claim; `policyId` files it under a reimbursement policy. */
export const participantClaimSchema = claimFieldsSchema.extend({ policyId: z.string().trim().max(128).default("") }).strict();
export const staffClaimSchema = claimFieldsSchema.extend({
  /** Someone else being paid back (a speaker or volunteer); blank is the person filing. */
  payeeName: z.string().trim().max(120).default(""),
  payeeEmail: z.string().trim().max(254).default(""),
}).strict();
export const decisionSchema = z.object({ claimId: id, note: z.string().trim().max(500).default("") }).strict();
export const approveSchema = decisionSchema.extend({ amount: z.string().trim().max(20).default("") }).strict();
export const payoutSchema = z.object({
  claimId: id,
  method: z.nativeEnum(OfflinePaymentMethod),
  reference: z.string().trim().max(120).optional(),
  note: z.string().trim().max(500).default(""),
  paidOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export const reverseSchema = z.object({ payoutId: id, reason: z.string().trim().min(1, "Say why it is reversed.").max(500) }).strict();

export const CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  TRAVEL: "Travel", ACCOMMODATION: "Accommodation", FOOD: "Food", VENUE: "Venue", EQUIPMENT: "Equipment",
  PRINTING: "Printing", MARKETING: "Marketing", SUPPLIES: "Supplies", OTHER: "Other",
};

/** The event's one currency, or the organisation's default before anything was priced. */
export async function financeCurrency(client: Prisma.TransactionClient, event: { currency: string | null; organisationId: string; }) {
  if (event.currency) return event.currency;
  return (await client.organisationPaymentSettings.findUnique({ where: { organisationId: event.organisationId }, select: { currency: true } }))?.currency ?? DEFAULT_CURRENCY;
}

/**
 * Receipt photos from a form: each checked, decoded, stripped of metadata and
 * re-encoded as WebP, then stored privately. Returns the stored keys, or why not.
 */
export async function storeReceipts(organisationId: string, files: File[]): Promise<{ keys: Array<{ key: string; byteSize: number; }>; } | { error: string; }> {
  const photos = files.filter((file) => file.size > 0);
  if (photos.length > MAX_RECEIPTS) return { error: `Attach up to ${MAX_RECEIPTS} receipt photos.` };
  const keys: Array<{ key: string; byteSize: number; }> = [];
  for (const file of photos) {
    if (file.size > MAX_RECEIPT_BYTES) {
      await deleteReceipts(keys.map((entry) => entry.key));
      return { error: "Each receipt photo must be 5 MB or smaller." };
    }
    const derivative = await createSafeWebpDerivative(file, { width: 2000, height: 2000, fit: "inside" });
    if ("error" in derivative) {
      await deleteReceipts(keys.map((entry) => entry.key));
      return { error: derivative.error };
    }
    const key = newReceiptKey(organisationId);
    await uploadReceipt(organisationId, key, derivative.body);
    keys.push({ key, byteSize: derivative.body.length });
  }
  return { keys };
}

/** The day something was paid, from a YYYY-MM-DD field: today when blank, never in the future. */
export function paidOnDate(paidOn: string | undefined) {
  const paidAt = paidOn ? new Date(`${paidOn}T12:00:00Z`) : new Date();
  return Number.isNaN(paidAt.getTime()) || paidAt.getTime() > Date.now() + 86_400_000 ? null : paidAt;
}
