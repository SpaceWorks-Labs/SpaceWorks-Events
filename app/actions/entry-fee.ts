"use server";

import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { isPaidEventsEnabled } from "@/lib/instanceSettings";
import { DEFAULT_CURRENCY, formatMoney, parseMoneyToMinor, providerMinimumMinor } from "@/lib/payments/money";
import { configuredProvider } from "@/lib/payments/settings";
import { access, revalidateOwner } from "./ticket-types/access";

const entryFeeSchema = z.object({
  organisationSlug: z.string().trim().min(1).max(120),
  eventId: z.string().trim().min(1).max(128),
  /** Typed amount in major units, e.g. "250"; blank or 0 is free. */
  fee: z.string().trim().max(20).default(""),
  refundOnDisqualify: z.boolean(),
}).strict();

/**
 * The hackathon entry fee (docs/HACKATHON.md): paid through the normal
 * checkout before a project is submitted. Same people as ticket prices: owners,
 * admins and collaborators with EDIT_DETAILS. Projects already paid for stay
 * paid when it changes.
 */
export async function saveEntryFee(input: unknown): Promise<ActionResult> {
  const parsed = entryFeeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the entry fee." };
  const context = await access(parsed.data);
  if ("error" in context) return { ok: false, error: context.error };
  if (!("eventId" in context.owner)) return { ok: false, error: "Event not found." };
  const eventId = context.owner.eventId;
  const settings = await prisma.organisationPaymentSettings.findUnique({ where: { organisationId: context.organisation.id } });
  const currency = context.currency ?? settings?.currency ?? DEFAULT_CURRENCY;
  const feeMinor = parsed.data.fee ? parseMoneyToMinor(parsed.data.fee, currency) : BigInt(0);
  if (feeMinor === null) return { ok: false, error: `Enter the fee in ${currency}, for example 250 or 250.50.` };
  if (feeMinor > BigInt(0)) {
    if (!(await isPaidEventsEnabled())) return { ok: false, error: "Paid tickets are turned off on this installation." };
    const provider = configuredProvider(settings);
    if (!provider) return { ok: false, error: "Connect a payment account in Settings → Payments before adding an entry fee." };
    const minimum = providerMinimumMinor(provider, currency);
    if (feeMinor < minimum) return { ok: false, error: `The smallest amount ${provider === "RAZORPAY" ? "Razorpay" : "Stripe"} accepts is ${formatMoney(minimum, currency)}.` };
  }
  const saved = await prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: eventId }, select: { submissionsEnabled: true, currency: true } });
    if (!event?.submissionsEnabled) return "Turn on project submissions first.";
    await tx.event.update({
      where: { id: eventId },
      data: {
        submissionFeeMinor: feeMinor > BigInt(0) ? feeMinor : null,
        submissionFeeRefundOnDisqualify: parsed.data.refundOnDisqualify,
        // The event's one currency is set with its first price.
        ...(feeMinor > BigInt(0) && !event.currency ? { currency } : {}),
      },
    });
    await recordAuditEvent({ action: "ENTRY_FEE_UPDATED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "Event", targetId: eventId, metadata: { paid: feeMinor > BigInt(0), refundOnDisqualify: parsed.data.refundOnDisqualify }, client: tx });
    return null;
  });
  if (saved) return { ok: false, error: saved };
  revalidateOwner(context);
  return { ok: true };
}
