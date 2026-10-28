import "server-only";

/** "You can claim expenses" for a reimbursement policy (docs/FINANCE.md "Reimbursement policies"). */

import { EventStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { evaluateEligibility, loadClaimant } from "@/lib/claims/policies/eligibility";
import { windowState } from "@/lib/claims/policies/math";
import { sendReimbursementAvailableEmail } from "@/lib/email/reimbursement";
import { formatDayTime } from "@/lib/format/datetime";
import { formatMoney } from "@/lib/payments/money";
import { safeTimeZone } from "@/lib/timeZone";
import { isBoundedString, isEmail } from "./payloads";

export const REIMBURSEMENT_AVAILABLE_KIND = "reimbursement-available";

/**
 * Ids only (and the organisation it is sent as). Everything else, including
 * whether the person still qualifies and the policy is still open, is read
 * at send time; the ticket link is built then and never stored.
 */
export type ReimbursementAvailablePayload = { to: string; policyId: string; rsvpId: string; organisationId: string };

export function asReimbursementAvailablePayload(value: Prisma.JsonValue): ReimbursementAvailablePayload | null {
  const p = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!p || !isEmail(p.to) || !isBoundedString(p.policyId, 64) || !isBoundedString(p.rsvpId, 64) || !isBoundedString(p.organisationId, 64)) return null;
  return p as ReimbursementAvailablePayload;
}

/**
 * "sent", "dropped" when it no longer applies, or null for an invalid payload
 * (permanent). A dropped message clears its ReimbursementNotice, so the beat
 * tells the person once the policy applies to them again.
 */
export async function deliverReimbursementAvailable(value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  const payload = asReimbursementAvailablePayload(value);
  if (!payload) return null;
  const outcome = await deliver(payload, messageId);
  if (outcome === "dropped") await prisma.reimbursementNotice.deleteMany({ where: { policyId: payload.policyId, rsvpId: payload.rsvpId } });
  return outcome;
}

async function deliver(payload: ReimbursementAvailablePayload, messageId: string): Promise<"sent" | "dropped"> {
  const policy = await prisma.reimbursementPolicy.findUnique({
    where: { id: payload.policyId },
    include: { event: { select: { id: true, title: true, status: true, currency: true, timezone: true, organisationId: true } } },
  });
  const event = policy?.event;
  if (!policy || !event || event.organisationId !== payload.organisationId || event.status !== EventStatus.PUBLISHED || !policy.active || !policy.notifyWhenAvailable || windowState(policy, new Date()) !== "open") return "dropped";
  const claimant = await loadClaimant(prisma, payload.rsvpId, event.id);
  if (!claimant || !(await evaluateEligibility(prisma, claimant, policy)).eligible) return "dropped";
  const rsvp = await prisma.rSVP.findUnique({ where: { id: payload.rsvpId }, select: { checkInToken: true, guestName: true, user: { select: { name: true } } } });
  if (!rsvp) return "dropped";
  await sendReimbursementAvailableEmail({
    to: payload.to,
    eventTitle: event.title,
    policyName: policy.name,
    cap: formatMoney(policy.capPerPersonMinor, event.currency ?? "INR"),
    closesAt: policy.claimClosesAt ? formatDayTime(policy.claimClosesAt.toISOString(), safeTimeZone(event.timezone)) : null,
    ticketPath: `/ticket/${encodeURIComponent(rsvp.checkInToken)}`,
    recipientName: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || undefined,
    messageId,
  });
  return "sent";
}
