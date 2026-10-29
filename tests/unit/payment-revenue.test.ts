import { describe, expect, it } from "vitest";
import { hasRevenue, summariseRevenue, type RevenueOrder } from "@/lib/payments/revenueMetrics";

const now = new Date("2030-03-10T12:00:00Z");
const b = (value: number) => BigInt(value);
type Payment = RevenueOrder["payments"][number];

function payment(overrides: Partial<Payment> = {}): Payment {
  return { status: "PAID_ONLINE", provider: "RAZORPAY", amountMinor: b(100000), testMode: false, paidAt: new Date("2030-03-09T10:00:00Z"), offlineMethod: null, refunds: [], disputes: [], ...overrides };
}

function order(overrides: Partial<RevenueOrder> = {}): RevenueOrder {
  return {
    id: Math.random().toString(36).slice(2),
    status: "CONFIRMED",
    currency: "INR",
    totalMinor: b(100000),
    discountMinor: b(0),
    holdExpiresAt: null,
    createdAt: new Date("2030-03-09T09:00:00Z"),
    lines: [{ kind: "TICKET", ticketTypeId: "general", description: "General", quantity: 2, totalMinor: b(100000) }],
    payments: [payment()],
    ...overrides,
  };
}

describe("summariseRevenue", () => {
  it("collects paid orders and subtracts refunds, settled or on their way", () => {
    const summary = summariseRevenue([
      order(),
      order({ payments: [payment({ refunds: [{ amountMinor: b(30000), status: "SUCCEEDED", automatic: false }] })] }),
      order({ payments: [payment({ refunds: [{ amountMinor: b(20000), status: "PENDING", automatic: false }, { amountMinor: b(50000), status: "FAILED", automatic: false }] })] }),
    ], { now, timeZone: "Asia/Kolkata" });
    expect(summary.collectedMinor).toBe(300000);
    expect(summary.refundedMinor).toBe(30000);
    expect(summary.refundPendingMinor).toBe(20000);
    expect(summary.netMinor).toBe(250000);
    expect(summary.orders.paid).toBe(3);
    expect(summary.byTicket).toEqual([{ name: "General", tickets: 6, revenueMinor: 300000 }]);
    expect(summary.byMethod).toEqual([{ label: "Razorpay", payments: 3, amountMinor: 300000 }]);
    expect(summary.test).toEqual({ payments: 0, collectedMinor: 0, refundedMinor: 0 });
  });

  it("splits fees, extras and discounts out of the ticket takings", () => {
    const summary = summariseRevenue([order({
      totalMinor: b(118000),
      discountMinor: b(10000),
      lines: [
        { kind: "TICKET", ticketTypeId: "vip", description: "VIP", quantity: 1, totalMinor: b(100000) },
        { kind: "ADD_ON", ticketTypeId: null, description: "T-shirt", quantity: 1, totalMinor: b(15000) },
        { kind: "FEE", ticketTypeId: null, description: "Booking fee", quantity: 1, totalMinor: b(3000) },
      ],
      payments: [payment({ amountMinor: b(118000) })],
    })], { now, timeZone: "UTC" });
    expect(summary).toMatchObject({ feesMinor: 3000, addOnsMinor: 15000, discountMinor: 10000 });
    expect(summary.byTicket).toEqual([{ name: "VIP", tickets: 1, revenueMinor: 100000 }]);
  });

  it("keeps late or duplicate payments returned automatically out of paid orders", () => {
    const summary = summariseRevenue([order({
      status: "EXPIRED",
      payments: [payment({ refunds: [{ amountMinor: b(100000), status: "SUCCEEDED", automatic: true }] })],
    })], { now, timeZone: "UTC" });
    expect(summary.orders.paid).toBe(0);
    expect(summary.automaticRefundMinor).toBe(100000);
    expect(summary.netMinor).toBe(0);
    expect(summary.byTicket).toEqual([]);
  });

  it("counts desk, complimentary, held and requested orders without calling them collected", () => {
    const summary = summariseRevenue([
      order({ payments: [payment({ status: "PENDING", provider: "OFFLINE", paidAt: null })] }),
      order({ payments: [payment({ status: "WAIVED", provider: "OFFLINE", paidAt: null })] }),
      order({ status: "PENDING", holdExpiresAt: new Date("2030-03-10T12:10:00Z"), payments: [payment({ status: "PENDING", paidAt: null })] }),
      order({ status: "PENDING", holdExpiresAt: new Date("2030-03-10T11:00:00Z"), payments: [] }),
      order({ status: "REQUESTED", payments: [] }),
    ], { now, timeZone: "UTC" });
    expect(summary.collectedMinor).toBe(0);
    expect(summary.orders).toMatchObject({ paid: 0, atDesk: 1, complimentary: 1, awaiting: 1, requested: 1 });
    expect(summary).toMatchObject({ owedAtDeskMinor: 100000, complimentaryValueMinor: 100000, heldMinor: 100000 });
    expect(hasRevenue(summary)).toBe(true);
  });

  it("labels in-person methods and tracks chargebacks", () => {
    const summary = summariseRevenue([
      order({ payments: [payment({ provider: "OFFLINE", status: "PAID_OFFLINE", offlineMethod: "CASH" })] }),
      order({ payments: [payment({ provider: "STRIPE", disputes: [{ status: "OPEN", amountMinor: b(100000) }] })] }),
      order({ payments: [payment({ disputes: [{ status: "LOST", amountMinor: b(40000) }, { status: "WON", amountMinor: b(1) }] })] }),
    ], { now, timeZone: "UTC" });
    expect(summary.byMethod.map((row) => row.label).sort()).toEqual(["Cash", "Razorpay", "Stripe"]);
    expect(summary.disputes).toEqual({ open: 1, openMinor: 100000, lost: 1, lostMinor: 40000 });
  });

  it("keeps test payments, their refunds and chargebacks out of the live totals, totalled apart", () => {
    const summary = summariseRevenue([
      order({ payments: [payment({ testMode: true, amountMinor: b(1000000), refunds: [{ amountMinor: b(5000), status: "SUCCEEDED", automatic: false }], disputes: [{ status: "OPEN", amountMinor: b(1000000) }] })] }),
      order({ payments: [payment({ amountMinor: b(10000), paidAt: new Date("2030-03-10T10:00:00Z") })] }),
    ], { now, timeZone: "UTC", days: 2 });
    expect(summary).toMatchObject({ collectedMinor: 10000, refundedMinor: 0, netMinor: 10000, orders: { paid: 1 } });
    expect(summary.byMethod).toEqual([{ label: "Razorpay", payments: 1, amountMinor: 10000 }]);
    expect(summary.byTicket).toEqual([{ name: "General", tickets: 2, revenueMinor: 100000 }]);
    expect(summary.disputes).toEqual({ open: 0, openMinor: 0, lost: 0, lostMinor: 0 });
    expect(summary.daily.largest).toBe(10000);
    expect(summary.test).toEqual({ payments: 1, collectedMinor: 1000000, refundedMinor: 5000 });
    // Only test money: nothing live, but still something to show.
    const testOnly = summariseRevenue([order({ payments: [payment({ testMode: true })] })], { now, timeZone: "UTC" });
    expect(testOnly).toMatchObject({ collectedMinor: 0, netMinor: 0, orders: { paid: 0 }, test: { payments: 1, collectedMinor: 100000 } });
    expect(hasRevenue(testOnly)).toBe(true);
    // Cash recorded at the desk is real money, whatever mode the account was in.
    const desk = summariseRevenue([order({ payments: [payment({ provider: "RAZORPAY", status: "PAID_OFFLINE", offlineMethod: "CASH", testMode: true })] })], { now, timeZone: "UTC" });
    expect(desk).toMatchObject({ collectedMinor: 100000, test: { payments: 0 } });
    expect(desk.byMethod).toEqual([{ label: "Cash", payments: 1, amountMinor: 100000 }]);
  });

  it("buckets collected money by day in the event's time zone", () => {
    const summary = summariseRevenue([
      order({ payments: [payment({ paidAt: new Date("2030-03-09T20:00:00Z") })] }),
      order({ payments: [payment({ paidAt: new Date("2030-03-10T02:00:00Z") })] }),
    ], { now, timeZone: "Asia/Kolkata", days: 3 });
    // 20:00 UTC on the 9th is already the 10th in India.
    expect(summary.daily.columns).toEqual([
      { label: "8 Mar", count: 0 },
      { label: "9 Mar", count: 0 },
      { label: "10 Mar", count: 200000 },
    ]);
    expect(summary.daily.largest).toBe(200000);
  });

  it("reports nothing to show for an empty or fully cancelled set", () => {
    const summary = summariseRevenue([order({ status: "CANCELLED", payments: [] })], { now, timeZone: "UTC" });
    expect(summary.orders.cancelled).toBe(1);
    expect(hasRevenue(summary)).toBe(false);
  });
});
