import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asPaymentEmailPayload } from "@/lib/payments/email";
import { isActiveHold, nextAttemptWindow, seatTakingWhere } from "@/lib/payments/holds";
import { checkoutLineName, priceOrder, PricingError } from "@/lib/payments/pricing";
import { paymentReturnUrl, verifyPaymentReturn } from "@/lib/payments/returnLink";
import { ticketSalesState } from "@/lib/payments/tickets";

const orderId = "cmabcdefghijklmnopqrstuvw";
const MINUTE = 60_000;

beforeEach(() => vi.stubEnv("MFA_ENCRYPTION_KEY", Buffer.alloc(32, 5).toString("base64")));
afterEach(() => vi.unstubAllEnvs());

describe("order pricing", () => {
  const types = [
    { id: "general", name: "General", priceMinor: BigInt(49900), minPerOrder: 1, maxPerOrder: 4 },
    { id: "student", name: "Student", priceMinor: BigInt(19900), minPerOrder: 1, maxPerOrder: 2 },
    { id: "free", name: "Community", priceMinor: BigInt(0), minPerOrder: 1, maxPerOrder: 10 },
  ];

  it("prices lines in exact minor units and merges repeated types", () => {
    const order = priceOrder([{ ticketTypeId: "general", quantity: 2 }, { ticketTypeId: "student", quantity: 1 }, { ticketTypeId: "general", quantity: 1 }], types);
    expect(order.lines.map((line) => [line.ticketTypeId, line.quantity, line.totalMinor])).toEqual([["general", 3, BigInt(149700)], ["student", 1, BigInt(19900)]]);
    expect(order).toMatchObject({ subtotalMinor: BigInt(169600), totalMinor: BigInt(169600), seats: 4 });
  });

  it("refuses empty orders, unknown tickets and quantities outside each ticket's limits", () => {
    expect(() => priceOrder([], types)).toThrow(PricingError);
    expect(() => priceOrder([{ ticketTypeId: "general", quantity: 0 }], types)).toThrow("Choose at least one ticket.");
    expect(() => priceOrder([{ ticketTypeId: "missing", quantity: 1 }], types)).toThrow("That ticket is no longer available.");
    expect(() => priceOrder([{ ticketTypeId: "student", quantity: 3 }], types)).toThrow("Student: up to 2 per order.");
    expect(() => priceOrder([{ ticketTypeId: "general", quantity: 1.5 }], types)).toThrow(PricingError);
    expect(() => priceOrder([{ ticketTypeId: "free", quantity: 10 }, { ticketTypeId: "general", quantity: 4 }, { ticketTypeId: "student", quantity: 2 }, { ticketTypeId: "free", quantity: 5 }], [...types.slice(0, 2), { ...types[2]!, maxPerOrder: 20 }])).toThrow("up to 20 tickets");
  });

  it("names multi-ticket lines for the provider page", () => {
    expect(checkoutLineName({ description: "General", quantity: 3 })).toBe("General × 3");
    expect(checkoutLineName({ description: "General", quantity: 1 })).toBe("General");
  });
});

describe("checkout attempt windows", () => {
  const now = new Date("2030-01-01T10:00:00.000Z");
  const hold = (minutes: number, capMinutes: number) => ({ expiresAt: new Date(now.getTime() + minutes * MINUTE), capAt: new Date(now.getTime() + capMinutes * MINUTE) });

  it("stretches a 30-minute hold so a Stripe page can live its 30-minute minimum", () => {
    expect(nextAttemptWindow("STRIPE", hold(30, 60), now)).toEqual({ holdExpiresAt: new Date(now.getTime() + 32 * MINUTE), attemptExpiresAt: new Date(now.getTime() + 32 * MINUTE) });
    expect(nextAttemptWindow("RAZORPAY", hold(30, 60), now)).toEqual({ holdExpiresAt: new Date(now.getTime() + 30 * MINUTE), attemptExpiresAt: new Date(now.getTime() + 30 * MINUTE) });
  });

  it("never stretches a hold past its cap", () => {
    expect(nextAttemptWindow("STRIPE", hold(10, 30), now)).toBeNull();
    expect(nextAttemptWindow("RAZORPAY", hold(10, 30), now)).toEqual({ holdExpiresAt: new Date(now.getTime() + 17 * MINUTE), attemptExpiresAt: new Date(now.getTime() + 17 * MINUTE) });
  });

  it("keeps a 24-hour hold, within Stripe's 24-hour page maximum", () => {
    const window = nextAttemptWindow("STRIPE", hold(25 * 60, 26 * 60), now)!;
    expect(window.holdExpiresAt).toEqual(new Date(now.getTime() + 25 * 60 * MINUTE));
    expect(window.attemptExpiresAt).toEqual(new Date(now.getTime() + 24 * 60 * MINUTE));
  });
});

describe("order return link", () => {
  it("never carries the order's access token and verifies only its own signature", () => {
    const url = new URL(paymentReturnUrl("https://events.example/", orderId));
    expect(url.pathname).toBe(`/api/payments/return/${orderId}`);
    const e = url.searchParams.get("e");
    const s = url.searchParams.get("s");
    expect(verifyPaymentReturn(orderId, e, s)).toBe(true);
    expect(verifyPaymentReturn("cmzzzzzzzzzzzzzzzzzzzzzzz", e, s)).toBe(false);
    expect(verifyPaymentReturn(orderId, String(Number(e) + 60), s)).toBe(false);
  });
});

describe("seat holds and sales windows", () => {
  const now = new Date("2030-01-01T10:00:00.000Z");

  it("counts confirmed registrations and only unexpired holds", () => {
    expect(seatTakingWhere(now)).toEqual({ isCrew: false, OR: [{ status: "CONFIRMED" }, { status: "PENDING_PAYMENT", holdExpiresAt: { gt: now } }] });
    expect(isActiveHold({ status: "PENDING_PAYMENT", holdExpiresAt: new Date(now.getTime() + 1000) }, now)).toBe(true);
    expect(isActiveHold({ status: "PENDING_PAYMENT", holdExpiresAt: now }, now)).toBe(false);
  });

  it("opens and closes ticket sales on the window boundaries", () => {
    expect(ticketSalesState({ salesStartAt: null, salesEndAt: null }, now)).toBe("on_sale");
    expect(ticketSalesState({ salesStartAt: new Date(now.getTime() + 1000), salesEndAt: null }, now)).toBe("not_started");
    expect(ticketSalesState({ salesStartAt: null, salesEndAt: now }, now)).toBe("ended");
  });
});

describe("payment email payloads", () => {
  it("accept only an address, an id and a known notice: never a capability", () => {
    expect(asPaymentEmailPayload({ to: "guest@example.test", paymentId: orderId, notice: "paid" })).toEqual({ to: "guest@example.test", paymentId: orderId, notice: "paid" });
    expect(asPaymentEmailPayload({ to: "guest@example.test", orderId, notice: "attendee-details" })).toEqual({ to: "guest@example.test", orderId, notice: "attendee-details" });
    expect(asPaymentEmailPayload({ to: "guest@example.test", paymentId: orderId, notice: "paid", accessToken: "secret" })).not.toHaveProperty("accessToken");
    expect(asPaymentEmailPayload({ to: "guest@example.test", orderId, notice: "paid" })).toBeNull();
    expect(asPaymentEmailPayload({ to: "nope", paymentId: orderId, notice: "paid" })).toBeNull();
  });
});
