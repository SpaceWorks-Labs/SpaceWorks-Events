import "server-only";

import { PaymentRefundStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { OnlineProvider } from "./http";
import { lockRefundPayment, settleRefundRow } from "./refunds";
import { loadPaymentAccount } from "./settings";

/** A refund the provider accepted is asked about once it has been pending this long. */
const RECONCILE_AFTER_MS = 60 * 60_000;
const BATCH = 25;

/**
 * Refunds the provider accepted (they have its id) but whose final webhook
 * never arrived: ask the provider where each stands, least recently checked
 * first so a few slow refunds never starve the rest. The provider is asked
 * outside any lock; the row then moves from PENDING only by a conditional
 * update under the payment lock, and only a row that changed is told about.
 * A timeout or unreadable answer leaves the refund PENDING, never FAILED,
 * and nothing here ever creates a provider refund.
 */
export async function reconcileProviderRefunds(now = new Date()) {
  const due = await prisma.paymentRefund.findMany({
    where: { status: PaymentRefundStatus.PENDING, offline: false, externalRefundId: { not: null }, createdAt: { lte: new Date(now.getTime() - RECONCILE_AFTER_MS) } },
    orderBy: [{ lastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: BATCH,
    select: { id: true, lastCheckedAt: true, externalRefundId: true, payment: { select: { organisationId: true, provider: true, externalPaymentId: true } } },
  });
  let settled = 0;
  for (const refund of due) {
    // Marked as checked first, so a refund the provider can't answer for moves to the back.
    const claimed = await prisma.$transaction(async (tx) => {
      await lockRefundPayment(tx, refund.id);
      return tx.paymentRefund.updateMany({ where: { id: refund.id, status: PaymentRefundStatus.PENDING, lastCheckedAt: refund.lastCheckedAt }, data: { lastCheckedAt: now } });
    });
    const { payment } = refund;
    if (claimed.count !== 1 || payment.provider === "OFFLINE" || !payment.externalPaymentId || !refund.externalRefundId) continue;
    const account = await loadPaymentAccount(payment.organisationId, payment.provider as OnlineProvider);
    if (!account) continue;
    let state;
    try {
      state = await account.gateway.getRefundStatus(payment.externalPaymentId, refund.externalRefundId);
    } catch {
      continue; // Unknown: asked again on a later pass.
    }
    if (state === PaymentRefundStatus.PENDING) continue;
    if (await settleRefundRow(refund.id, payment.organisationId, { state }, new Date())) settled += 1;
  }
  return settled;
}
