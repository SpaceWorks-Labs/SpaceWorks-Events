import type { PaymentMethodDetails } from "@/lib/payments/paymentMethod";
/**
 * The payment provider seam. Razorpay (Payment Links) and Stripe (Checkout
 * Sessions) sit behind it; event, ticket and refund code never learns which
 * one is in use. Rules every provider keeps:
 *
 * - Hosted checkout only: the platform never sees card, UPI or bank details.
 * - Amounts are integer minor units (bigint); currencies are uppercase ISO.
 * - Every failure is a PaymentsUnavailable, never a vendor-shaped exception.
 * - Webhooks are verified over the raw body before anything is parsed.
 */

export type RefundState = "PENDING" | "SUCCEEDED" | "FAILED";

/**
 * How long a hosted page may live. Stripe Checkout needs 30 minutes to 24
 * hours; a Razorpay link needs at least 15 minutes. Callers choose an expiry
 * inside the window; clients refuse anything outside it.
 */
export const CHECKOUT_WINDOWS = {
  RAZORPAY: { minMs: 15 * 60_000, maxMs: 180 * 24 * 60 * 60_000 },
  STRIPE: { minMs: 30 * 60_000, maxMs: 24 * 60 * 60_000 },
} as const;

export type CheckoutLine = { name: string; amountMinor: bigint; };

export type CheckoutRequest = {
  /** Our checkout attempt id: unique per page (Razorpay requires a unique
   * reference_id per link) and echoed back so settlement never trusts payer input. */
  reference: string;
  amountMinor: bigint;
  currency: string;
  /** Event and ticket names only; no attendee details. */
  description: string;
  /**
   * The order's priced lines, shown to the buyer. Stripe lists them; Razorpay
   * charges the total and names them in the description. They sum to amountMinor.
   */
  lines: CheckoutLine[];
  /** Where the provider sends the attendee after paying. */
  returnUrl: string;
  /** Where the provider sends the attendee if they leave the page (Stripe). */
  cancelUrl: string;
  /** When the page stops accepting payment; inside the provider's CHECKOUT_WINDOWS. */
  expiresAt: Date;
  customerEmail?: string;
  idempotencyKey: string;
};

export type CheckoutResult = { checkoutId: string; checkoutUrl: string; };

export type CheckoutStatus =
  | { state: "open"; }
  | { state: "closed"; }
  | { state: "paid"; paymentId: string; amountMinor: bigint | null; currency: string | null; };

export type RefundRequest = {
  /** The provider's captured payment id (Razorpay pay_…, Stripe pi_…). */
  paymentId: string;
  amountMinor: bigint;
  currency: string;
  /** Our PaymentRefund id, echoed on refund webhooks. */
  reference: string;
  idempotencyKey: string;
};

export type RefundResult = { refundId: string; state: RefundState; };

export interface PaymentGateway {
  /** A cheap authenticated read that proves the keys work. */
  testConnection(): Promise<void>;
  createCheckout(request: CheckoutRequest): Promise<CheckoutResult>;
  getCheckoutStatus(checkoutId: string): Promise<CheckoutStatus>;
  /**
   * Close an open checkout so it can no longer be paid. Returns the state
   * afterwards: "closed" once cancelled or expired, "paid" when the attendee
   * paid first. Throws PaymentsUnavailable when the outcome is unknown.
   */
  cancelCheckout(checkoutId: string): Promise<CheckoutStatus>;
  createRefund(request: RefundRequest): Promise<RefundResult>;
  /**
   * The provider's refund carrying our reference, if one exists. A retry after
   * an unknown outcome checks this first so money is never returned twice.
   */
  findRefund(paymentId: string, reference: string): Promise<RefundResult | null>;
  /**
   * Where a refund the provider already accepted stands now, by its id, for
   * maintenance when no webhook settled it. Throws PaymentsUnavailable when
   * the answer is unknown (a timeout or an outage), which is never a failure.
   */
  getRefundStatus(paymentId: string, refundId: string): Promise<RefundState>;
  /** How a captured payment was made, for the receipt; null when the provider doesn't say. */
  getPaymentMethod(paymentId: string): Promise<PaymentMethodDetails | null>;
}

/** Refuse an expiry outside the provider's window rather than let it be clamped silently. */
export function assertCheckoutWindow(provider: keyof typeof CHECKOUT_WINDOWS, expiresAt: Date, now = Date.now()) {
  const window = CHECKOUT_WINDOWS[provider];
  const lifetime = expiresAt.getTime() - now;
  return lifetime >= window.minMs - 60_000 && lifetime <= window.maxMs;
}

export type PaidNotification = {
  checkoutId: string | null;
  /** Our checkout attempt id, echoed by the provider. */
  reference: string | null;
  paymentId: string;
  amountMinor: bigint | null;
  currency: string | null;
};

export type RefundNotification = {
  refundId: string;
  paymentId: string | null;
  reference: string | null;
  state: RefundState;
  amountMinor: bigint | null;
};

/** A verified, provider-neutral webhook. Anything not listed is ignored. */
/** A chargeback on a captured payment, opened or updated by the provider. */
export type DisputeNotification = {
  disputeId: string;
  /** The provider's payment id (Razorpay pay_…, Stripe pi_…). */
  paymentId: string;
  status: "OPEN" | "UNDER_REVIEW" | "WON" | "LOST" | "CLOSED";
  amountMinor: bigint | null;
  currency: string | null;
  reason: string | null;
  respondBy: Date | null;
};

export type VerifiedWebhookEvent = {
  eventId: string;
  eventType: string;
  dispute?: DisputeNotification | null;
  paid: PaidNotification | null;
  refunds: RefundNotification[];
  /** A hosted page that expired or was cancelled unpaid. */
  closedCheckoutId: string | null;
};

/** The request did not carry a signature this provider accepts. Never settle it. */
export class WebhookVerificationError extends Error {
  constructor() {
    super("Webhook signature verification failed.");
    this.name = "WebhookVerificationError";
  }
}

/** Provider object ids are interpolated into API paths, so they must be plain tokens. */
export function isProviderId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{3,255}$/.test(value);
}
