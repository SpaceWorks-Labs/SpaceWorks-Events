/**
 * Revenue for reports: pure, so the dashboard, the PDF and the tests agree.
 * Amounts are integer minor units of one currency. "Collected" is money
 * actually taken (online or recorded in person); refunds count once they
 * are on their way; complimentary and free tickets bring in nothing.
 */

import { cachedDateTimeFormat } from "@/lib/format/intlCache";

export type RevenueOrder = {
  id: string;
  status: "REQUESTED" | "PENDING" | "CONFIRMED" | "EXPIRED" | "CANCELLED";
  currency: string;
  totalMinor: bigint;
  discountMinor: bigint;
  holdExpiresAt: Date | null;
  createdAt: Date;
  lines: Array<{ kind: "TICKET" | "ADD_ON" | "FEE"; ticketTypeId: string | null; description: string; quantity: number; totalMinor: bigint; }>;
  payments: Array<{
    status: "PENDING" | "PAID_ONLINE" | "PAID_OFFLINE" | "WAIVED" | "CANCELED" | "EXPIRED";
    provider: "RAZORPAY" | "STRIPE" | "OFFLINE";
    amountMinor: bigint;
    testMode: boolean;
    paidAt: Date | null;
    offlineMethod: string | null;
    refunds: Array<{ amountMinor: bigint; status: "PENDING" | "SUCCEEDED" | "FAILED"; automatic: boolean; }>;
    disputes: Array<{ status: "OPEN" | "UNDER_REVIEW" | "WON" | "LOST" | "CLOSED"; amountMinor: bigint; }>;
  }>;
};

export type RevenueSummary = {
  currency: string;
  /** Every collected payment was a test: no real money moved. */
  testOnly: boolean;
  orders: { paid: number; complimentary: number; atDesk: number; awaiting: number; requested: number; cancelled: number; };
  collectedMinor: number;
  refundedMinor: number;
  refundPendingMinor: number;
  /** Late or duplicate payments returned automatically (included in refunded). */
  automaticRefundMinor: number;
  netMinor: number;
  discountMinor: number;
  feesMinor: number;
  addOnsMinor: number;
  complimentaryValueMinor: number;
  /** Reserved to pay at the desk, not yet collected. */
  owedAtDeskMinor: number;
  /** Seats being paid for right now. */
  heldMinor: number;
  byTicket: Array<{ name: string; tickets: number; revenueMinor: number; }>;
  byMethod: Array<{ label: string; payments: number; amountMinor: number; }>;
  disputes: { open: number; openMinor: number; lost: number; lostMinor: number; };
  /** Money collected per day (minor units) for the last `days` days, in the event's zone. */
  daily: { columns: Array<{ label: string; count: number; }>; largest: number; };
};

const ZERO = BigInt(0);
const n = (value: bigint) => Number(value);
const COLLECTED = new Set(["PAID_ONLINE", "PAID_OFFLINE"]);
const OFFLINE_LABELS: Record<string, string> = { CASH: "Cash", UPI: "UPI (in person)", BANK_TRANSFER: "Bank transfer", CARD_TERMINAL: "Card terminal", OTHER: "Other (in person)" };

function dayKey(date: Date, timeZone: string) {
  try {
    return cachedDateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function dayLabel(key: string) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** One currency's revenue from its orders (callers group orders by currency first). */
export function summariseRevenue(orders: RevenueOrder[], options: { now: Date; timeZone: string; days?: number; }): RevenueSummary {
  const days = options.days ?? 14;
  const currency = orders[0]?.currency ?? "INR";
  let collected = ZERO;
  let refunded = ZERO;
  let refundPending = ZERO;
  let automatic = ZERO;
  let discount = ZERO;
  let fees = ZERO;
  let addOns = ZERO;
  let complimentaryValue = ZERO;
  let owedAtDesk = ZERO;
  let held = ZERO;
  let anyReal = false;
  let anyCollected = false;
  const counts = { paid: 0, complimentary: 0, atDesk: 0, awaiting: 0, requested: 0, cancelled: 0 };
  const byTicket = new Map<string, { name: string; tickets: number; revenue: bigint; }>();
  const byMethod = new Map<string, { label: string; payments: number; amount: bigint; }>();
  const disputes = { open: 0, openMinor: ZERO, lost: 0, lostMinor: ZERO };
  const perDay = new Map<string, bigint>();

  for (const order of orders) {
    const taken = order.payments.filter((payment) => COLLECTED.has(payment.status));
    const waived = order.payments.some((payment) => payment.status === "WAIVED");
    if (order.status === "CANCELLED") counts.cancelled += 1;
    if (order.status === "REQUESTED") counts.requested += 1;
    if (order.status === "PENDING" && order.holdExpiresAt && order.holdExpiresAt > options.now) {
      counts.awaiting += 1;
      held += order.totalMinor;
    }
    const desk = order.status === "CONFIRMED" && order.payments.some((payment) => payment.status === "PENDING" && payment.provider === "OFFLINE");
    if (desk) {
      counts.atDesk += 1;
      owedAtDesk += order.payments.filter((payment) => payment.status === "PENDING").reduce((sum, payment) => sum + payment.amountMinor, ZERO);
    }
    if (waived && taken.length === 0) {
      counts.complimentary += 1;
      complimentaryValue += order.totalMinor;
    }
    if (taken.length === 0) continue;
    anyCollected = true;
    // Payments that bought tickets (an automatic refund returned a late or duplicate one).
    const kept = taken.filter((payment) => !payment.refunds.some((refund) => refund.automatic && refund.status !== "FAILED"));
    if (kept.length > 0) {
      counts.paid += 1;
      discount += order.discountMinor;
      for (const line of order.lines) {
        if (line.kind === "FEE") fees += line.totalMinor;
        else if (line.kind === "ADD_ON") addOns += line.totalMinor;
        else {
          const key = line.ticketTypeId ?? line.description;
          const entry = byTicket.get(key) ?? { name: line.description, tickets: 0, revenue: ZERO };
          entry.tickets += line.quantity;
          entry.revenue += line.totalMinor;
          byTicket.set(key, entry);
        }
      }
    }
    for (const payment of taken) {
      if (!payment.testMode) anyReal = true;
      collected += payment.amountMinor;
      const label = payment.provider === "OFFLINE" ? OFFLINE_LABELS[payment.offlineMethod ?? "OTHER"] ?? "In person" : payment.provider === "RAZORPAY" ? "Razorpay" : "Stripe";
      const method = byMethod.get(label) ?? { label, payments: 0, amount: ZERO };
      method.payments += 1;
      method.amount += payment.amountMinor;
      byMethod.set(label, method);
      if (payment.paidAt) {
        const key = dayKey(payment.paidAt, options.timeZone);
        perDay.set(key, (perDay.get(key) ?? ZERO) + payment.amountMinor);
      }
      for (const refund of payment.refunds) {
        if (refund.status === "SUCCEEDED") refunded += refund.amountMinor;
        else if (refund.status === "PENDING") refundPending += refund.amountMinor;
        if (refund.automatic && refund.status !== "FAILED") automatic += refund.amountMinor;
      }
      for (const dispute of payment.disputes) {
        if (dispute.status === "OPEN" || dispute.status === "UNDER_REVIEW") {
          disputes.open += 1;
          disputes.openMinor += dispute.amountMinor;
        } else if (dispute.status === "LOST") {
          disputes.lost += 1;
          disputes.lostMinor += dispute.amountMinor;
        }
      }
    }
  }

  const columns: Array<{ label: string; count: number; }> = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const key = dayKey(new Date(options.now.getTime() - back * 86_400_000), options.timeZone);
    columns.push({ label: dayLabel(key), count: n(perDay.get(key) ?? ZERO) });
  }
  const totalRefunds = refunded + refundPending;
  return {
    currency,
    testOnly: anyCollected && !anyReal,
    orders: counts,
    collectedMinor: n(collected),
    refundedMinor: n(refunded),
    refundPendingMinor: n(refundPending),
    automaticRefundMinor: n(automatic),
    netMinor: n(collected - totalRefunds),
    discountMinor: n(discount),
    feesMinor: n(fees),
    addOnsMinor: n(addOns),
    complimentaryValueMinor: n(complimentaryValue),
    owedAtDeskMinor: n(owedAtDesk),
    heldMinor: n(held),
    byTicket: [...byTicket.values()].map((entry) => ({ name: entry.name, tickets: entry.tickets, revenueMinor: n(entry.revenue) })).sort((a, b) => b.revenueMinor - a.revenueMinor),
    byMethod: [...byMethod.values()].map((entry) => ({ label: entry.label, payments: entry.payments, amountMinor: n(entry.amount) })).sort((a, b) => b.amountMinor - a.amountMinor),
    disputes: { open: disputes.open, openMinor: n(disputes.openMinor), lost: disputes.lost, lostMinor: n(disputes.lostMinor) },
    daily: { columns, largest: Math.max(0, ...columns.map((column) => column.count)) },
  };
}

/** Whether there's any money to report: something collected, owed, held or given away. */
export function hasRevenue(summary: RevenueSummary) {
  return summary.collectedMinor > 0 || summary.owedAtDeskMinor > 0 || summary.heldMinor > 0 || summary.orders.complimentary > 0 || summary.orders.requested > 0;
}
