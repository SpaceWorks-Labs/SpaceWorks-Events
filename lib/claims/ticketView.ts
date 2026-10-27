import "server-only";

import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { CATEGORY_LABELS, financeCurrency } from "./shared";

/**
 * The ticket page's "Claim expenses" section (docs/FINANCE.md): shown to a
 * confirmed participant when the event takes participant claims, with the
 * cap and this registration's own claims, or to a crew member (docs/CREW.md)
 * when it takes crew claims, without a cap. Null otherwise.
 */
export async function loadTicketClaims(rsvp: { id: string; eventId: string | null; status: RsvpStatus; isCrew?: boolean; }) {
  if (!rsvp.eventId || rsvp.status !== RsvpStatus.CONFIRMED) return null;
  const event = await prisma.event.findUnique({ where: { id: rsvp.eventId }, select: { organisationId: true, currency: true, participantClaimsEnabled: true, participantClaimCapMinor: true, crewClaimsEnabled: true } });
  const crew = rsvp.isCrew === true;
  if (!(crew ? event?.crewClaimsEnabled : event?.participantClaimsEnabled) || !event) return null;
  const currency = await financeCurrency(prisma, event);
  const claims = await prisma.expenseClaim.findMany({
    where: { rsvpId: rsvp.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, status: true, category: true, amountMinor: true, approvedMinor: true, currency: true, decisionNote: true },
  });
  return {
    currency,
    crew,
    cap: !crew && event.participantClaimCapMinor ? formatMoney(event.participantClaimCapMinor, currency) : null,
    categories: Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label })),
    claims: claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      category: CATEGORY_LABELS[claim.category],
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      note: claim.decisionNote,
    })),
  };
}

export type TicketClaimsView = NonNullable<Awaited<ReturnType<typeof loadTicketClaims>>>;
