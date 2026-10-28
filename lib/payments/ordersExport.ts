import "server-only";

import type { Prisma } from "@prisma/client";
import { csvByteStream } from "@/lib/csvExport";
import { prisma } from "@/lib/db";
import { minorToDecimalString } from "./money";

const BATCH = 500;

export const ORDER_EXPORT_HEADER = [
  "Order", "Placed at", "Status", "Buyer name", "Buyer email", "Date", "Tickets", "Items", "Currency",
  "Subtotal", "Discount", "Promo code", "Booking fees", "Extras", "Total", "Paid", "Payment method",
  "Provider payment ID", "Paid at", "Refunded", "Refund pending", "Owed at desk", "Chargeback", "Test",
];

const select = {
  id: true, reference: true, createdAt: true, status: true, buyerName: true, buyerEmail: true, currency: true,
  subtotalMinor: true, discountMinor: true, totalMinor: true, testMode: true,
  promoCode: { select: { hint: true } },
  instance: { select: { startDateTime: true } },
  lines: { select: { kind: true, description: true, quantity: true, totalMinor: true } },
  rsvps: { select: { id: true } },
  payments: {
    orderBy: { createdAt: "asc" },
    select: {
      status: true, provider: true, amountMinor: true, paidAt: true, externalPaymentId: true, offlineMethod: true, methodSummary: true,
      refunds: { select: { amountMinor: true, status: true } },
      disputes: { orderBy: { updatedAt: "desc" }, take: 1, select: { status: true } },
    },
  },
} satisfies Prisma.OrderSelect;

type ExportOrder = Prisma.OrderGetPayload<{ select: typeof select; }>;

function row(order: ExportOrder, timeZone: string) {
  const money = (minor: bigint) => minorToDecimalString(minor, order.currency);
  const sum = (values: bigint[]) => values.reduce((total, value) => total + value, BigInt(0));
  const taken = order.payments.filter((payment) => payment.status === "PAID_ONLINE" || payment.status === "PAID_OFFLINE");
  const refunds = taken.flatMap((payment) => payment.refunds);
  const desk = order.status === "CONFIRMED" ? order.payments.filter((payment) => payment.status === "PENDING" && payment.provider === "OFFLINE") : [];
  const first = taken[0];
  const method = first
    ? first.provider === "OFFLINE" ? `In person (${(first.offlineMethod ?? "OTHER").toLowerCase().replace(/_/g, " ")})` : [first.provider === "RAZORPAY" ? "Razorpay" : "Stripe", first.methodSummary].filter(Boolean).join(" · ")
    : order.payments.some((payment) => payment.status === "WAIVED") ? "Complimentary" : desk.length ? "Pay at the desk" : "";
  return [
    order.reference,
    order.createdAt.toISOString(),
    order.status,
    order.buyerName,
    order.buyerEmail,
    order.instance ? order.instance.startDateTime.toLocaleString("en-GB", { timeZone }) : "",
    String(order.rsvps.length),
    order.lines.filter((line) => line.kind !== "FEE").map((line) => `${line.description} × ${line.quantity}`).join("; "),
    order.currency,
    money(order.subtotalMinor),
    money(order.discountMinor),
    order.promoCode ? `${order.promoCode.hint}…` : "",
    money(sum(order.lines.filter((line) => line.kind === "FEE").map((line) => line.totalMinor))),
    money(sum(order.lines.filter((line) => line.kind === "ADD_ON").map((line) => line.totalMinor))),
    money(order.totalMinor),
    money(sum(taken.map((payment) => payment.amountMinor))),
    method,
    taken.map((payment) => payment.externalPaymentId).filter(Boolean).join(" "),
    first?.paidAt?.toISOString() ?? "",
    money(sum(refunds.filter((refund) => refund.status === "SUCCEEDED").map((refund) => refund.amountMinor))),
    money(sum(refunds.filter((refund) => refund.status === "PENDING").map((refund) => refund.amountMinor))),
    money(sum(desk.map((payment) => payment.amountMinor))),
    taken.flatMap((payment) => payment.disputes)[0]?.status ?? "",
    order.testMode ? "yes" : "",
  ];
}

/** Every order of an event or series as CSV, streamed in batches. Amounts are in major units. */
export function ordersCsvStream(owner: { eventId: string; } | { eventSeriesId: string; }, timeZone: string) {
  // Pull-based: the next batch is read only once the download has taken the last one.
  return csvByteStream({
    header: ORDER_EXPORT_HEADER,
    errorMessage: "Unable to export orders.",
    async *batches() {
      let cursor: string | undefined;
      while (true) {
        const orders = await prisma.order.findMany({ where: owner, orderBy: { id: "asc" }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select });
        if (!orders.length) return;
        yield orders.map((order) => row(order, timeZone));
        cursor = orders.at(-1)?.id;
      }
    },
  });
}

export function ordersCsvResponse(stream: ReadableStream<Uint8Array>, title: string) {
  const safe = title.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").slice(0, 50) || "event";
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="orders_${safe}_${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
