import "server-only";

import { prisma } from "@/lib/db";
import { DEFAULT_CURRENCY, formatMoney, minorToDecimalString } from "@/lib/payments/money";
import { offlineMethodLabel } from "@/lib/payments/paymentMethod";

/**
 * The Prizes view of the Judging tab (docs/HACKATHON.md): each award's prize,
 * its winners with what has been paid to them, and the payout ledger, newest
 * first. Amounts are formatted here; the browser never sees BigInts.
 */
export async function loadPrizeLedger(eventId: string, organisationId: string) {
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId }, select: { currency: true, timezone: true } });
  if (!event) return null;
  const currency = event.currency ?? (await prisma.organisationPaymentSettings.findUnique({ where: { organisationId }, select: { currency: true } }))?.currency ?? DEFAULT_CURRENCY;
  const [awards, payouts] = await Promise.all([
    prisma.eventAward.findMany({
      where: { eventId },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, name: true, prizeMinor: true,
        winners: {
          orderBy: { place: "asc" },
          select: { place: true, submission: { select: { id: true, title: true, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } } } } },
        },
      },
    }),
    prisma.prizePayout.findMany({ where: { eventId, organisationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 500 }),
  ]);
  const reversed = new Set(payouts.flatMap((payout) => (payout.reversesId ? [payout.reversesId] : [])));
  const net = new Map<string, bigint>();
  for (const payout of payouts) {
    const key = `${payout.awardId}:${payout.submissionId}`;
    net.set(key, (net.get(key) ?? BigInt(0)) + (payout.reversesId ? -payout.amountMinor : payout.amountMinor));
  }
  const totalPaid = [...net.values()].reduce((sum, value) => sum + value, BigInt(0));
  const totalPrizes = awards.reduce((sum, award) => sum + (award.prizeMinor ?? BigInt(0)) * BigInt(award.winners.length), BigInt(0));
  return {
    currency,
    totals: { prizes: formatMoney(totalPrizes, currency), paid: formatMoney(totalPaid, currency) },
    awards: awards.map((award) => ({
      id: award.id,
      name: award.name,
      prize: award.prizeMinor ? minorToDecimalString(award.prizeMinor, currency) : "",
      prizeLabel: award.prizeMinor ? formatMoney(award.prizeMinor, currency) : null,
      winners: award.winners.map((winner) => {
        const paid = net.get(`${award.id}:${winner.submission.id}`) ?? BigInt(0);
        const entrant = winner.submission.team?.name ?? (winner.submission.rsvp?.user?.name?.trim() || winner.submission.rsvp?.guestName?.trim() || "Entrant");
        return {
          submissionId: winner.submission.id,
          place: winner.place,
          title: winner.submission.title,
          entrant,
          paidLabel: formatMoney(paid, currency),
          // What is still owed, as a typed amount for the payout form.
          owed: award.prizeMinor && award.prizeMinor > paid ? minorToDecimalString(award.prizeMinor - paid, currency) : "",
        };
      }),
    })),
    payouts: payouts.map((payout) => ({
      id: payout.id,
      awardName: payout.awardName,
      projectTitle: payout.projectTitle,
      recipientName: payout.recipientName,
      amountLabel: `${payout.reversesId ? "−" : ""}${formatMoney(payout.amountMinor, payout.currency)}`,
      method: offlineMethodLabel(payout.method),
      reference: payout.reference,
      note: payout.note,
      paidAt: payout.paidAt.toISOString(),
      isReversal: payout.reversesId != null,
      reversed: reversed.has(payout.id),
    })),
  };
}

export type PrizeLedgerView = NonNullable<Awaited<ReturnType<typeof loadPrizeLedger>>>;
