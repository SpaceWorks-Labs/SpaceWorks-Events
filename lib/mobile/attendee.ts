import "server-only";

import { ExpenseClaimKind, RsvpStatus } from "@prisma/client";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { CATEGORY_LABELS } from "@/lib/claims/shared";
import { resolveEntrantForUser } from "@/lib/core/judging/entrantAuth";
import { loadEntrantSubmission } from "@/lib/core/judging/entrantSubmissions";
import { entrantWhere } from "@/lib/core/judging/entrantAuth";
import { prisma } from "@/lib/db";
import { formatMoney } from "@/lib/payments/money";
import { myPrizesDtoSchema, myReimbursementsDtoSchema, mySubmissionsDtoSchema, participantClaimsDtoSchema, staffClaimsDtoSchema } from "@/lib/mobile/schemas";

/*
 * The signed-in attendee's own money and entries: participant expense
 * claims, hackathon projects with their entry fee, and prizes won. Every
 * read starts from the caller's own registrations; anything else is
 * NOT_FOUND. Bearer links (ticket, submission, team) are looked up only to
 * drive the website's own code and never returned.
 */

/** The caller's own registration and its ticket token, or null. */
export async function ownRegistration(userId: string, rsvpId: string) {
  if (!rsvpId || rsvpId.length > 128) return null;
  return prisma.rSVP.findFirst({ where: { id: rsvpId, userId }, select: { id: true, eventId: true, status: true, checkInToken: true } });
}

/** This registration's claims, cap and categories; null when the event takes no participant claims. */
export async function loadMyParticipantClaims(userId: string, rsvpId: string) {
  const rsvp = await ownRegistration(userId, rsvpId);
  if (!rsvp) return undefined;
  const view = await loadTicketClaims(rsvp);
  return view ? participantClaimsDtoSchema.parse({ currency: view.currency, cap: view.cap, categories: view.categories, claims: view.claims }) : null;
}

/** The reimbursement policies open to this registration now, with what is left under each; null when there is nothing to claim. */
export async function loadMyReimbursements(userId: string, rsvpId: string) {
  const rsvp = await ownRegistration(userId, rsvpId);
  if (!rsvp) return undefined;
  const view = await loadTicketClaims(rsvp);
  if (!view || (!view.general && view.policies.length === 0)) return null;
  return myReimbursementsDtoSchema.parse({
    currency: view.currency,
    general: view.general ? { cap: view.cap } : null,
    policies: view.policies.map(({ id, name, who, cap, left, categories, claimClosesAt }) => ({ id, name, who, cap, left, categories, claimClosesAt })),
  });
}

/** The caller's own staff claims on one event (any status). */
export async function loadMyStaffClaims(userId: string, eventId: string) {
  const claims = await prisma.expenseClaim.findMany({
    where: { eventId, submittedByUserId: userId, kind: { not: ExpenseClaimKind.PARTICIPANT } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, status: true, category: true, description: true, amountMinor: true, approvedMinor: true, currency: true, decisionNote: true, createdAt: true, receipts: { select: { id: true } } },
  });
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { currency: true } });
  return staffClaimsDtoSchema.parse({
    currency: claims[0]?.currency ?? event?.currency ?? "INR",
    claims: claims.map((claim) => ({
      id: claim.id,
      status: claim.status,
      category: CATEGORY_LABELS[claim.category],
      amount: formatMoney(claim.amountMinor, claim.currency),
      approved: claim.approvedMinor != null ? formatMoney(claim.approvedMinor, claim.currency) : null,
      note: claim.decisionNote || null,
      policy: null,
      description: claim.description,
      createdAt: claim.createdAt.toISOString(),
      receiptIds: claim.receipts.map((receipt) => receipt.id),
    })),
  });
}

/** Every hackathon event the caller is registered for, with their project and entry fee. */
export async function listMySubmissions(userId: string) {
  const rsvps = await prisma.rSVP.findMany({
    where: { userId, event: { submissionsEnabled: true } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { eventId: true },
  });
  const submissions = [];
  for (const eventId of new Set(rsvps.map((row) => row.eventId!))) {
    const entrant = await resolveEntrantForUser(userId, eventId);
    const view = entrant ? await loadEntrantSubmission(entrant) : null;
    if (!view) continue;
    submissions.push({
      eventId,
      eventTitle: view.eventTitle,
      entrantName: view.entrantName,
      isTeam: view.isTeam,
      window: { opensAt: view.window.opensAt?.toISOString() ?? null, closesAt: view.window.closesAt?.toISOString() ?? null, isOpen: view.window.isOpen },
      confirmed: view.confirmed,
      declined: view.declined,
      canEdit: view.canEdit,
      submission: view.submission ? {
        title: view.submission.title,
        summary: view.submission.summary,
        status: view.submission.status,
        submittedAt: view.submission.submittedAt?.toISOString() ?? null,
        links: { repo: view.submission.repoUrl, demo: view.submission.demoUrl, video: view.submission.videoUrl },
      } : null,
      entryFee: view.entryFee ? {
        amount: formatMoney(view.entryFee.amountMinor, view.entryFee.currency),
        amountMinor: view.entryFee.amountMinor.toString(),
        currency: view.entryFee.currency,
        paid: view.entryFee.paid,
      } : null,
    });
  }
  return mySubmissionsDtoSchema.parse({ submissions });
}

/** The caller's project on one event (for the entry fee), or null. */
export async function mySubmissionOn(userId: string, eventId: string) {
  const entrant = await resolveEntrantForUser(userId, eventId);
  if (!entrant) return null;
  const where = entrant.kind === "team-member" ? entrantWhere({ eventId, teamId: entrant.teamId, rsvpId: null }) : entrant.kind === "solo-owner" ? entrantWhere({ eventId, teamId: null, rsvpId: entrant.rsvpId }) : null;
  return where ? prisma.submission.findFirst({ where, select: { id: true } }) : null;
}

/**
 * Prizes the caller's projects won, with what has been paid out: amount and
 * date only. Payout references, notes and who recorded them stay with the
 * organisers.
 */
export async function listMyPrizes(userId: string) {
  const rsvps = await prisma.rSVP.findMany({ where: { userId, status: RsvpStatus.CONFIRMED, event: { submissionsEnabled: true } }, select: { id: true, teamId: true }, take: 100 });
  const teamIds = rsvps.flatMap((row) => row.teamId ? [row.teamId] : []);
  const soloIds = rsvps.filter((row) => !row.teamId).map((row) => row.id);
  const winners = await prisma.eventAwardWinner.findMany({
    where: { submission: { OR: [{ teamId: { in: teamIds } }, { rsvpId: { in: soloIds } }] }, award: { event: { resultsPublishedAt: { not: null } } } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      place: true,
      submission: { select: { id: true, title: true } },
      award: { select: { id: true, name: true, prizeMinor: true, event: { select: { title: true, currency: true } } } },
    },
  });
  const payouts = winners.length > 0 ? await prisma.prizePayout.findMany({
    where: { submissionId: { in: winners.map((winner) => winner.submission.id) } },
    orderBy: { paidAt: "asc" },
    select: { id: true, awardId: true, submissionId: true, amountMinor: true, currency: true, paidAt: true, reversesId: true },
  }) : [];
  const reversed = new Set(payouts.flatMap((payout) => payout.reversesId ? [payout.reversesId] : []));
  return myPrizesDtoSchema.parse({
    prizes: winners.map((winner) => ({
      eventTitle: winner.award.event.title,
      awardName: winner.award.name,
      place: winner.place,
      projectTitle: winner.submission.title,
      prize: winner.award.prizeMinor != null ? formatMoney(winner.award.prizeMinor, winner.award.event.currency ?? "INR") : null,
      payouts: payouts
        .filter((payout) => payout.awardId === winner.award.id && payout.submissionId === winner.submission.id && !payout.reversesId)
        .map((payout) => ({ amount: formatMoney(payout.amountMinor, payout.currency), paidAt: payout.paidAt.toISOString(), reversed: reversed.has(payout.id) })),
    })),
  });
}
