import "server-only";

import { CheckoutAttemptStatus, OrderStatus, PaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { checkRateLimitById } from "@/lib/rateLimit";
import { nextAttemptWindow } from "./holds";
import { PaymentsUnavailable, type OnlineProvider } from "./http";
import { checkoutLineName } from "./pricing";
import { submitPendingRefund } from "./refunds";
import { paymentReturnUrl } from "./returnLink";
import { settlePaidNotification } from "./settlement";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { lockOrderTargets, ORDER_SUBJECT_SELECT, orderSubject } from "./targets";
import { loadPaymentAccount } from "./settings";

function publicBaseUrl() {
  const base = process.env.NEXT_PUBLIC_BASE_URL?.trim().replace(/\/$/, "");
  return base && /^https?:\/\//.test(base) ? base : null;
}

export type CheckoutOutcome =
  | { url: string; }
  | { error: "hold_ended" | "hold_ending" | "unavailable" | "busy"; };

/** A page still worth sending the buyer to: open, known, and not about to expire. */
const REUSE_MARGIN_MS = 3 * 60_000;

/**
 * The hosted checkout page for an order's pending payment. Each page is a
 * new PaymentCheckoutAttempt whose id is the provider reference (Razorpay
 * needs a unique reference_id per link). Opening one extends the hold to the
 * provider's minimum page lifetime, never past the hold's cap, and the
 * provider is called outside any lock.
 *
 * Extending a hold takes the same event (or series and dates) locks as a new
 * reservation, before the order, and reads the time only once it has them:
 * a hold that ended meanwhile is refused, never revived, so a reservation
 * that already counted its seats as free can't be oversold.
 */
export async function startCheckout(orderId: string, at?: Date): Promise<CheckoutOutcome> {
  const base = publicBaseUrl();
  const prepared = await prisma.$transaction(async (tx) => {
    const row = await tx.order.findUnique({ where: { id: orderId }, select: { id: true, eventId: true, eventSeriesId: true } });
    if (row) await lockOrderTargets(tx, row);
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const now = at ?? new Date();
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, organisationId: true, status: true, holdExpiresAt: true, holdCapAt: true, totalMinor: true, currency: true, buyerEmail: true,
        ...ORDER_SUBJECT_SELECT,
        lines: { select: { description: true, quantity: true, totalMinor: true }, orderBy: { createdAt: "asc" } },
        payments: {
          where: { status: PaymentStatus.PENDING },
          select: { id: true, provider: true, amountMinor: true, attempts: { where: { status: CheckoutAttemptStatus.OPEN }, select: { id: true, url: true, expiresAt: true, externalId: true, createdAt: true } } },
        },
      },
    });
    if (!order || order.status !== OrderStatus.PENDING || !order.holdExpiresAt || !order.holdCapAt || order.holdExpiresAt <= now) return { error: "hold_ended" as const };
    const payment = order.payments[0];
    if (!payment || payment.provider === "OFFLINE") return { error: "unavailable" as const };
    const reusable = payment.attempts.find((attempt) => attempt.url && attempt.externalId && attempt.expiresAt.getTime() > now.getTime() + REUSE_MARGIN_MS);
    if (reusable?.url) return { url: reusable.url };
    // Another request is creating a page right now.
    if (payment.attempts.some((attempt) => !attempt.externalId && attempt.createdAt.getTime() > now.getTime() - 60_000)) return { error: "busy" as const };
    const provider = payment.provider as OnlineProvider;
    const window = nextAttemptWindow(provider, { expiresAt: order.holdExpiresAt, capAt: order.holdCapAt }, now);
    if (!window) return { error: "hold_ending" as const };
    if (!base) return { error: "unavailable" as const };
    if (window.holdExpiresAt > order.holdExpiresAt) {
      await tx.order.update({ where: { id: order.id }, data: { holdExpiresAt: window.holdExpiresAt } });
      await tx.rSVP.updateMany({ where: { orderId: order.id, status: "PENDING_PAYMENT" }, data: { holdExpiresAt: window.holdExpiresAt } });
    }
    const attempt = await tx.paymentCheckoutAttempt.create({ data: { paymentId: payment.id, provider, expiresAt: window.attemptExpiresAt }, select: { id: true } });
    return { prepared: { order, payment, provider, attemptId: attempt.id, expiresAt: window.attemptExpiresAt } };
  });
  if (!prepared.prepared) return prepared as CheckoutOutcome;
  const { order, payment, provider, attemptId, expiresAt } = prepared.prepared;

  const account = await loadPaymentAccount(order.organisationId, provider);
  let checkout: { checkoutId: string; checkoutUrl: string; } | null = null;
  if (account) {
    const returnUrl = paymentReturnUrl(base!, order.id);
    try {
      checkout = await account.gateway.createCheckout({
        reference: attemptId,
        amountMinor: payment.amountMinor,
        currency: order.currency,
        description: orderSubject(order)?.title ?? "Event tickets",
        lines: order.lines.map((line) => ({ name: checkoutLineName(line), amountMinor: line.totalMinor })),
        returnUrl,
        cancelUrl: returnUrl,
        expiresAt,
        customerEmail: order.buyerEmail,
        idempotencyKey: `attempt:${attemptId}`,
      });
    } catch (error) {
      if (!(error instanceof PaymentsUnavailable)) throw error;
    }
  }
  if (!checkout) {
    await prisma.paymentCheckoutAttempt.updateMany({ where: { id: attemptId, status: CheckoutAttemptStatus.OPEN }, data: { status: CheckoutAttemptStatus.CANCELLED } });
    return { error: "unavailable" };
  }
  await prisma.paymentCheckoutAttempt.update({ where: { id: attemptId }, data: { externalId: checkout.checkoutId, url: checkout.checkoutUrl } });
  return { url: checkout.checkoutUrl };
}

/**
 * One server-side status read when the buyer comes back from checkout, so the
 * order can confirm before the webhook arrives. Rate limited per order; the
 * webhook remains the authority.
 */
export async function refreshOrderFromProvider(orderId: string) {
  const attempts = await prisma.paymentCheckoutAttempt.findMany({
    where: { status: CheckoutAttemptStatus.OPEN, externalId: { not: null }, payment: { orderId, status: PaymentStatus.PENDING } },
    select: { id: true, provider: true, externalId: true, payment: { select: { organisationId: true } } },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  if (attempts.length === 0 || !(await checkRateLimitById("paymentStatus", `order:${orderId}`))) return;
  for (const attempt of attempts) {
    const provider = attempt.provider as OnlineProvider;
    const account = await loadPaymentAccount(attempt.payment.organisationId, provider);
    if (!account) continue;
    let status;
    try {
      status = await account.gateway.getCheckoutStatus(attempt.externalId!);
    } catch {
      continue;
    }
    if (status.state !== "paid") continue;
    const paid = status;
    const result = await prisma.$transaction((tx) => settlePaidNotification(tx, { organisationId: attempt.payment.organisationId, provider }, {
      checkoutId: attempt.externalId, reference: attempt.id, paymentId: paid.paymentId, amountMinor: paid.amountMinor, currency: paid.currency,
    }));
    for (const refundId of result.refundIds) await submitPendingRefund(refundId).catch(() => undefined);
    for (const webhook of result.webhooks ?? []) emitWebhookEvent(webhook);
    return;
  }
}

/** A page creation that never finished (a crash mid-request) is abandoned after this. */
const STALLED_ATTEMPT_MS = 5 * 60_000;

/**
 * Cancel every open provider page for an order, before its seats are
 * released or it is settled by hand. "open" when a page may still take money
 * (try again later); "settled" when the buyer had already paid, which is then
 * settled (and refunded if the seats are gone).
 */
export async function closeOpenAttempts(orderId: string, now = new Date()): Promise<"closed" | "open" | "settled"> {
  const attempts = await prisma.paymentCheckoutAttempt.findMany({
    where: { status: CheckoutAttemptStatus.OPEN, payment: { orderId } },
    select: { id: true, provider: true, externalId: true, createdAt: true, payment: { select: { organisationId: true } } },
  });
  for (const attempt of attempts) {
    if (!attempt.externalId) {
      // The provider may still have created it; its webhook would carry our attempt id.
      if (attempt.createdAt.getTime() > now.getTime() - STALLED_ATTEMPT_MS) return "open";
      continue;
    }
    const provider = attempt.provider as OnlineProvider;
    const account = await loadPaymentAccount(attempt.payment.organisationId, provider);
    // Without keys the page can't be cancelled; a later payment still arrives by
    // webhook and is refunded if the seats are gone.
    if (!account) continue;
    let state;
    try {
      state = await account.gateway.cancelCheckout(attempt.externalId);
    } catch {
      return "open"; // Outcome unknown: keep the seats held and retry next tick.
    }
    if (state.state === "open") return "open";
    if (state.state === "paid") {
      const paid = state;
      const result = await prisma.$transaction((tx) => settlePaidNotification(tx, { organisationId: attempt.payment.organisationId, provider }, {
        checkoutId: attempt.externalId, reference: attempt.id, paymentId: paid.paymentId, amountMinor: paid.amountMinor, currency: paid.currency,
      }, now));
      for (const refundId of result.refundIds) await submitPendingRefund(refundId).catch(() => undefined);
      for (const webhook of result.webhooks ?? []) emitWebhookEvent(webhook);
      return "settled";
    }
  }
  return "closed";
}
