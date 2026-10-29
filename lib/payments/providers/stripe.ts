import "server-only";

import { PaymentsUnavailable, providerRequest } from "@/lib/payments/http";
import { parseMinorAmount } from "@/lib/payments/money";
import { describePaymentMethod } from "@/lib/payments/paymentMethod";
import { hmacSha256Hex, safeEqualHex } from "./signature";
import {
  assertCheckoutWindow,
  isProviderId,
  WebhookVerificationError,
  type CheckoutRequest,
  type CheckoutResult,
  type CheckoutStatus,
  type DisputeNotification,
  type PaymentGateway,
  type RefundNotification,
  type RefundRequest,
  type RefundResult,
  type RefundState,
  type VerifiedWebhookEvent,
} from "./types";

/** Stripe through hosted Checkout Sessions, spoken as form-encoded REST. */

export const STRIPE_REFUND_EVENTS = new Set(["refund.created", "refund.updated", "charge.refunded"]);

const REFUND_STATES: Record<string, RefundState> = {
  succeeded: "SUCCEEDED",
  pending: "PENDING",
  requires_action: "PENDING",
  failed: "FAILED",
  canceled: "FAILED",
};

const SIGNATURE_TOLERANCE_SECONDS = 300;

type Entity = Record<string, unknown>;

function record(value: unknown): Entity {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Entity : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : null;
}

function upperCurrency(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

/** The PaymentIntent id, whether Stripe sent it as a string or an expanded object. */
function intentId(value: unknown): string | null {
  if (isProviderId(value)) return value;
  const id = record(value).id;
  return isProviderId(id) ? id : null;
}

function form(params: Record<string, string | number>) {
  return new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)])).toString();
}

export class StripeGateway implements PaymentGateway {
  constructor(private readonly secretKey: string) {
    if (!secretKey) throw new PaymentsUnavailable("Stripe credentials are not configured.");
  }

  private call<T = Entity>(method: "GET" | "POST", path: string, params?: Record<string, string | number>, idempotencyKey?: string) {
    return providerRequest<T>({
      provider: "STRIPE",
      method,
      path,
      authorization: `Bearer ${this.secretKey}`,
      body: params ? form(params) : undefined,
      contentType: "application/x-www-form-urlencoded",
      idempotencyKey,
    });
  }

  async testConnection() {
    await this.call("GET", "/v1/balance");
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    if (!assertCheckoutWindow("STRIPE", request.expiresAt)) throw new PaymentsUnavailable("The checkout expiry is outside Stripe's window.");
    const total = request.lines.reduce((sum, line) => sum + line.amountMinor, BigInt(0));
    if (request.lines.length === 0 || total !== request.amountMinor) throw new PaymentsUnavailable("Checkout lines must add up to the total.");
    // Each order line is one item (quantity 1 at its line total), so discounts
    // that don't divide evenly per ticket still add up to the exact total.
    const lines: Record<string, string | number> = {};
    request.lines.slice(0, 100).forEach((line, index) => {
      lines[`line_items[${index}][quantity]`] = 1;
      lines[`line_items[${index}][price_data][currency]`] = request.currency.toLowerCase();
      lines[`line_items[${index}][price_data][unit_amount]`] = line.amountMinor.toString();
      lines[`line_items[${index}][price_data][product_data][name]`] = line.name.slice(0, 250);
    });
    const session = await this.call("POST", "/v1/checkout/sessions", {
      mode: "payment",
      client_reference_id: request.reference,
      success_url: request.returnUrl,
      cancel_url: request.cancelUrl,
      expires_at: Math.floor(request.expiresAt.getTime() / 1000),
      ...lines,
      "metadata[attempt_id]": request.reference,
      "payment_intent_data[metadata][attempt_id]": request.reference,
      "payment_intent_data[description]": request.description.slice(0, 500),
      ...(request.customerEmail ? { customer_email: request.customerEmail } : {}),
    }, request.idempotencyKey);
    if (!isProviderId(session.id) || typeof session.url !== "string" || !/^https?:\/\//.test(session.url)) {
      throw new PaymentsUnavailable("Stripe did not return a Checkout URL.");
    }
    return { checkoutId: session.id, checkoutUrl: session.url };
  }

  async getCheckoutStatus(checkoutId: string): Promise<CheckoutStatus> {
    if (!isProviderId(checkoutId)) throw new PaymentsUnavailable("Invalid Stripe session id.");
    const session = await this.call("GET", `/v1/checkout/sessions/${checkoutId}`);
    const paymentId = intentId(session.payment_intent);
    if (session.status === "complete" && session.payment_status === "paid" && paymentId) {
      return { state: "paid", paymentId, amountMinor: parseMinorAmount(session.amount_total), currency: upperCurrency(session.currency) };
    }
    if (session.status === "expired") return { state: "closed" };
    return { state: "open" };
  }

  async cancelCheckout(checkoutId: string): Promise<CheckoutStatus> {
    if (!isProviderId(checkoutId)) throw new PaymentsUnavailable("Invalid Stripe session id.");
    try {
      await this.call("POST", `/v1/checkout/sessions/${checkoutId}/expire`, {});
      return { state: "closed" };
    } catch (error) {
      // Only an open session can be expired; a completed one may be paid.
      if (error instanceof PaymentsUnavailable && error.status === 400) {
        const status = await this.getCheckoutStatus(checkoutId);
        if (status.state !== "open") return status;
      }
      throw error;
    }
  }

  async createRefund(request: RefundRequest): Promise<RefundResult> {
    if (!isProviderId(request.paymentId)) throw new PaymentsUnavailable("The payment has no Stripe PaymentIntent to refund.");
    const refund = await this.call("POST", "/v1/refunds", {
      payment_intent: request.paymentId,
      amount: request.amountMinor.toString(),
      "metadata[refund_id]": request.reference,
    }, request.idempotencyKey);
    if (!isProviderId(refund.id)) throw new PaymentsUnavailable("Stripe did not return a refund id.");
    return { refundId: refund.id, state: REFUND_STATES[String(refund.status)] ?? "PENDING" };
  }

  async getPaymentMethod(paymentId: string) {
    if (!isProviderId(paymentId)) throw new PaymentsUnavailable("Invalid Stripe PaymentIntent id.");
    const intent = await this.call("GET", `/v1/payment_intents/${paymentId}?expand[]=latest_charge`);
    const details = record(record(intent.latest_charge).payment_method_details);
    const type = details.type;
    const specific = typeof type === "string" ? record(details[type]) : {};
    return describePaymentMethod({ type, brand: specific.brand, last4: specific.last4, vpa: specific.vpa, bank: specific.bank_name ?? specific.bank, wallet: record(specific.wallet).type });
  }

  async findRefund(paymentId: string, reference: string): Promise<RefundResult | null> {
    if (!isProviderId(paymentId)) throw new PaymentsUnavailable("Invalid Stripe PaymentIntent id.");
    const list = await this.call("GET", `/v1/refunds?payment_intent=${paymentId}&limit=100`);
    const items = Array.isArray(list.data) ? list.data.map(record) : [];
    const match = items.find((item) => record(item.metadata).refund_id === reference && isProviderId(item.id));
    return match ? { refundId: match.id as string, state: REFUND_STATES[String(match.status)] ?? "PENDING" } : null;
  }

  async getRefundStatus(_paymentId: string, refundId: string): Promise<RefundState> {
    if (!isProviderId(refundId)) throw new PaymentsUnavailable("Invalid Stripe refund id.");
    const refund = await this.call("GET", `/v1/refunds/${refundId}`);
    if (refund.id !== refundId) throw new PaymentsUnavailable("Stripe sent an unreadable refund.");
    return REFUND_STATES[String(refund.status)] ?? "PENDING";
  }
}

function refundNotification(refund: Entity): RefundNotification | null {
  if (!isProviderId(refund.id)) return null;
  return {
    refundId: refund.id,
    paymentId: intentId(refund.payment_intent),
    reference: text(record(refund.metadata).refund_id),
    state: REFUND_STATES[String(refund.status)] ?? "PENDING",
    amountMinor: parseMinorAmount(refund.amount),
  };
}

/**
 * Verify Stripe-Signature (`t=…,v1=…`: hex HMAC-SHA256 of `t.rawBody` with
 * the organisation's endpoint secret, within five minutes) and normalise the
 * event. Throws WebhookVerificationError for anything else.
 */
export function verifyStripeWebhook(secret: string, rawBody: Buffer, headers: Headers, now = Date.now()): VerifiedWebhookEvent {
  const header = headers.get("stripe-signature") ?? "";
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && value) timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!secret || !/^\d{1,12}$/.test(timestamp) || signatures.length === 0 || signatures.length > 8) throw new WebhookVerificationError();
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) throw new WebhookVerificationError();
  const expected = hmacSha256Hex(secret, `${timestamp}.`, rawBody);
  if (!signatures.some((signature) => safeEqualHex(expected, signature))) throw new WebhookVerificationError();

  let event: Entity;
  try {
    event = record(JSON.parse(rawBody.toString("utf8")));
  } catch {
    throw new WebhookVerificationError();
  }
  const eventId = text(event.id);
  if (!eventId) throw new WebhookVerificationError();
  const eventType = typeof event.type === "string" ? event.type.slice(0, 80) : "";
  const object = record(record(event.data).object);

  let paid: VerifiedWebhookEvent["paid"] = null;
  // A bank-debit session completes before the money moves, so "completed"
  // counts only when Stripe already says it is paid.
  const isPaid = (eventType === "checkout.session.completed" && object.payment_status === "paid")
    || eventType === "checkout.session.async_payment_succeeded";
  const paymentId = intentId(object.payment_intent);
  if (isPaid && paymentId) {
    paid = {
      checkoutId: isProviderId(object.id) ? object.id : null,
      reference: text(object.client_reference_id) ?? text(record(object.metadata).attempt_id),
      paymentId,
      amountMinor: parseMinorAmount(object.amount_total),
      currency: upperCurrency(object.currency),
    };
  }

  const refunds: RefundNotification[] = [];
  if (eventType === "refund.created" || eventType === "refund.updated") {
    const refund = refundNotification(object);
    if (refund) refunds.push(refund);
  } else if (eventType === "charge.refunded") {
    const list = record(object.refunds).data;
    for (const item of Array.isArray(list) ? list.slice(0, 50) : []) {
      const refund = refundNotification(record(item));
      if (refund) refunds.push(refund);
    }
  }

  const closedCheckoutId = eventType === "checkout.session.expired" && isProviderId(object.id) ? object.id : null;

  // charge.dispute.created / updated / closed: the object is the dispute.
  let dispute: DisputeNotification | null = null;
  const disputedIntent = intentId(object.payment_intent);
  if (eventType.startsWith("charge.dispute.") && isProviderId(object.id) && disputedIntent) {
    const status = String(object.status ?? "");
    const due = record(object.evidence_details).due_by;
    dispute = {
      disputeId: object.id,
      paymentId: disputedIntent,
      status: status === "won" ? "WON" : status === "lost" ? "LOST" : status === "under_review" || status === "warning_under_review" ? "UNDER_REVIEW" : status === "warning_closed" || status === "charge_refunded" ? "CLOSED" : "OPEN",
      amountMinor: parseMinorAmount(object.amount),
      currency: upperCurrency(object.currency),
      reason: text(object.reason),
      respondBy: typeof due === "number" ? new Date(due * 1000) : null,
    };
  }

  return { eventId, eventType, paid, refunds, closedCheckoutId, dispute };
}

/** Stripe secret and restricted keys say whether they are test keys. */
export function isStripeTestKey(secretKey: string) {
  return /^(sk|rk)_test_/.test(secretKey);
}
