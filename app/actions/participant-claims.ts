"use server";

import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { auth } from "@/lib/auth";
import { submitParticipantClaim, withdrawClaim } from "@/lib/claims/submit";
import { prisma } from "@/lib/db";
import { requestRefund } from "@/lib/refundRequests";

/**
 * Money asked for by the people who registered (docs/FINANCE.md): expense
 * claims from the ticket page (travel grants), and refund requests from the
 * order page. The ticket or order token is the proof, as elsewhere; an
 * account-owned ticket also needs that account signed in.
 */

const TOKEN = /^[A-Za-z0-9_-]{8,256}$/;

/** File a claim from a ticket (multipart: `ticketToken`, the fields, an optional `policyId`, up to three `receipts`); answers the new claim's id. */
export async function submitParticipantClaimAction(formData: FormData): Promise<ActionResult<{ claimId: string; }>> {
  const ticketToken = String(formData.get("ticketToken") ?? "");
  if (!TOKEN.test(ticketToken)) return { ok: false, error: "Registration not found." };
  if (await isActionRateLimited("action", ticketToken)) return { ok: false, error: "Too many claims. Try again shortly." };
  const session = await auth();
  const field = (name: string) => String(formData.get(name) ?? "");
  const files = formData.getAll("receipts").filter((value): value is File => value instanceof File);
  const result = await submitParticipantClaim({ ticketToken, actorUserId: session?.user?.id ?? null }, { category: field("category"), description: field("description"), amount: field("amount"), policyId: field("policyId") }, files);
  return result.ok ? { ok: true, data: { claimId: result.data.claimId } } : result;
}

/** Withdraw one of this ticket's claims before it is decided. */
export async function withdrawParticipantClaimAction(ticketToken: unknown, claimId: unknown): Promise<ActionResult> {
  if (typeof ticketToken !== "string" || !TOKEN.test(ticketToken) || typeof claimId !== "string") return { ok: false, error: "Claim not found." };
  if (await isActionRateLimited("action", ticketToken)) return { ok: false, error: "Too many changes. Try again shortly." };
  const rsvp = await prisma.rSVP.findUnique({ where: { checkInToken: ticketToken }, select: { id: true, userId: true } });
  const session = await auth();
  if (!rsvp || (rsvp.userId && rsvp.userId !== session?.user?.id)) return { ok: false, error: "Claim not found." };
  return withdrawClaim(claimId.slice(0, 128), { userId: null, rsvpId: rsvp.id });
}

/** Ask for a refund outside the automatic policy, from the order page. */
export async function requestRefundAction(orderToken: unknown, reason: unknown): Promise<ActionResult> {
  if (typeof orderToken !== "string" || !TOKEN.test(orderToken)) return { ok: false, error: "Order not found." };
  if (await isActionRateLimited("action", orderToken)) return { ok: false, error: "Too many requests. Try again shortly." };
  return requestRefund(orderToken, reason);
}
