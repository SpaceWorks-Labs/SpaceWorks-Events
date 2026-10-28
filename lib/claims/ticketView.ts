import "server-only";

import { RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { loadClaimant } from "./policies/eligibility";
import { availablePolicies, whoLabel } from "./policies/view";
import { CATEGORY_LABELS, financeCurrency } from "./shared";

/**
 * The ticket page's "Claim expenses" section (docs/FINANCE.md): shown to a
 * confirmed participant when the event takes participant claims, with the
 * cap and this registration's own claims, or to a crew member (docs/CREW.md)
 * when it takes crew claims, without a cap. It also lists the reimbursement
 * policies open to this registration now, with what is left under each.
 * Null when there is nothing to claim and nothing claimed.
 */
export async function loadTicketClaims(rsvp: { id: string; eventId: string | null; status: RsvpStatus; isCrew?: boolean; }) {
  if (!rsvp.eventId || rsvp.status !== RsvpStatus.CONFIRMED) return null;
  const event = await prisma.event.findUnique({ where: { id: rsvp.eventId }, select: { organisationId: true, currency: true, participantClaimsEnabled: true, participantClaimCapMinor: true, crewClaimsEnabled: true } });
  if (!event) return null;
  const crew = rsvp.isCrew === true;
  const general = crew ? event.crewClaimsEnabled : event.participantClaimsEnabled;
  const claimant = await loadClaimant(prisma, rsvp.id, rsvp.eventId);
  const open = claimant ? await availablePolicies(prisma, claimant) : [];
  const claims = await prisma.expenseClaim.findMany({
    where: { rsvpId: rsvp.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, status: true, category: true, amountMinor: true, approvedMinor: true, currency: true, decisionNote: true, policy: { select: { name: true } } },
  });
  if (!general && open.length === 0 && claims.length === 0) return null;
  const currency = await financeCurrency(prisma, event);
  const categoryOptions = (values: string[]) => values.map((value) => ({ value, label: CATEGORY_LABELS[value as keyof typeof CATEGORY_LABELS] }));
  return {
    currency,
    crew,
    /** The event's general claims (no policy) are open to this registration. */
    general,
    cap: general && !crew && event.participantClaimCapMinor ? formatMoney(event.participantClaimCapMinor, currency) : null,
    categories: categoryOptions(Object.keys(CATEGORY_LABELS)),
    policies: open.map(({ policy, left }) => ({
      id: policy.id,
      name: policy.name,
      who: whoLabel(policy),
      cap: formatMoney(policy.capPerPersonMinor, currency),
      left: formatMoney(left, currency),
      categories: categoryOptions(policy.categories),
      claimClosesAt: policy.claimClosesAt?.toISOString() ?? null,
    })),
    claims: claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      category: CATEGORY_LABELS[claim.category],
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      note: claim.decisionNote,
      policy: claim.policy?.name ?? null,
    })),
  };
}

export type TicketClaimsView = NonNullable<Awaited<ReturnType<typeof loadTicketClaims>>>;
