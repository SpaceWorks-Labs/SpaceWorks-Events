import { PaymentRefundStatus, PaymentStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { csvStreamResponse, exportFilename, exportNotFound } from "@/lib/csvExport";
import { prisma } from "@/lib/db";
import { minorToDecimalString } from "@/lib/payments/money";
import { offlineMethodLabel } from "@/lib/payments/paymentMethod";
import { getMembership, isOrgAdmin } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ eventId: string }> };

const HEADER = ["Date", "Type", "Who", "Description", "Amount", "Currency", "Method", "Reference"];
type Row = { at: Date; cells: string[]; };

/**
 * Finance → "Download CSV" (docs/FINANCE.md): every money movement of the
 * event, oldest first: payments in (tickets and entry fees), refunds, paid
 * expense claims and prize payouts, reversals included, signed from the
 * organisation's side. Owners and admins only; every denial is an empty 404.
 */
export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return exportNotFound();
  const { eventId } = await context.params;
  if (!eventId || eventId.length > 128) return exportNotFound();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, organisationId: true } });
  if (!event) return exportNotFound();
  const membership = await getMembership(userId, event.organisationId);
  if (!membership || !isOrgAdmin(membership.role)) return exportNotFound();

  const [payments, claimPayouts, prizePayouts] = await Promise.all([
    prisma.payment.findMany({
      where: { order: { eventId }, status: { in: [PaymentStatus.PAID_ONLINE, PaymentStatus.PAID_OFFLINE] } },
      select: {
        amountMinor: true, currency: true, paidAt: true, createdAt: true, provider: true, offlineMethod: true, methodSummary: true, description: true, testMode: true, status: true,
        order: { select: { reference: true, buyerName: true, submissionId: true } },
        refunds: { where: { status: { in: [PaymentRefundStatus.PENDING, PaymentRefundStatus.SUCCEEDED] } }, select: { amountMinor: true, settledAt: true, createdAt: true, offline: true, status: true } },
      },
    }),
    prisma.claimPayout.findMany({ where: { eventId }, select: { payeeName: true, amountMinor: true, currency: true, method: true, reference: true, paidAt: true, reversesId: true, claim: { select: { description: true } } } }),
    prisma.prizePayout.findMany({ where: { eventId }, select: { recipientName: true, awardName: true, amountMinor: true, currency: true, method: true, reference: true, paidAt: true, reversesId: true } }),
  ]);
  const amount = (value: bigint, currency: string, sign: 1 | -1) => `${sign < 0 ? "-" : ""}${minorToDecimalString(value, currency)}`;
  const rows: Row[] = [];
  for (const payment of payments) {
    const at = payment.paidAt ?? payment.createdAt;
    const method = payment.provider === "OFFLINE" || payment.offlineMethod ? offlineMethodLabel(payment.offlineMethod ?? "OTHER") : payment.methodSummary ?? payment.provider;
    // Test-key payments moved no real money: labelled, as on the Finance tab.
    const test = payment.testMode && payment.status === PaymentStatus.PAID_ONLINE ? " (test)" : "";
    rows.push({ at, cells: [at.toISOString(), `${payment.order.submissionId ? "Entry fee" : "Ticket payment"}${test}`, payment.order.buyerName, payment.description, amount(payment.amountMinor, payment.currency, 1), payment.currency, method, payment.order.reference] });
    for (const refund of payment.refunds) {
      const refundAt = refund.settledAt ?? refund.createdAt;
      rows.push({ at: refundAt, cells: [refundAt.toISOString(), `${refund.status === PaymentRefundStatus.PENDING ? "Refund (pending)" : "Refund"}${test}`, payment.order.buyerName, payment.description, amount(refund.amountMinor, payment.currency, -1), payment.currency, refund.offline ? "In person" : method, payment.order.reference] });
    }
  }
  for (const payout of claimPayouts) {
    rows.push({ at: payout.paidAt, cells: [payout.paidAt.toISOString(), payout.reversesId ? "Expense payout reversed" : "Expense payout", payout.payeeName, payout.claim?.description ?? "", amount(payout.amountMinor, payout.currency, payout.reversesId ? 1 : -1), payout.currency, offlineMethodLabel(payout.method), payout.reference ?? ""] });
  }
  for (const payout of prizePayouts) {
    rows.push({ at: payout.paidAt, cells: [payout.paidAt.toISOString(), payout.reversesId ? "Prize payout reversed" : "Prize payout", payout.recipientName, payout.awardName, amount(payout.amountMinor, payout.currency, payout.reversesId ? 1 : -1), payout.currency, offlineMethodLabel(payout.method), payout.reference ?? ""] });
  }
  rows.sort((a, b) => a.at.getTime() - b.at.getTime());

  await recordAuditEvent({ action: "EVENT_FINANCE_EXPORTED", actorUserId: userId, organisationId: event.organisationId, targetType: "Event", targetId: event.id, metadata: { rows: rows.length } });
  return csvStreamResponse({
    header: HEADER,
    // One bounded batch, read above.
    batches: async function* batches() { yield rows.map((row) => row.cells); },
    filename: exportFilename("finance", event.title),
    errorMessage: "Unable to export the event's finances.",
  });
}
