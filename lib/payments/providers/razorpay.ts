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

/**
 * Razorpay through Payment Links: the attendee gets a hosted page URL, the
 * same shape as Stripe Checkout, so there is no embedded widget.
 */

// Only these mean "the money is captured". `payment.authorized` deliberately
// does not: an authorised payment can still fail to arrive.
export const RAZORPAY_PAID_EVENTS = new Set(["payment_link.paid", "order.paid", "payment.captured"]);
export const RAZORPAY_REFUND_EVENTS = new Set(["refund.processed", "refund.failed"]);

const REFUND_STATES: Record<string, RefundState> = {
  processed: "SUCCEEDED",
  pending: "PENDING",
  created: "PENDING",
  failed: "FAILED",
};

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

export class RazorpayGateway implements PaymentGateway {
  constructor(private readonly keyId: string, private readonly keySecret: string) {
    if (!keyId || !keySecret) throw new PaymentsUnavailable("Razorpay credentials are not configured.");
  }

  private call<T = Entity>(method: "GET" | "POST", path: string, body?: unknown, refundIdempotencyKey?: string) {
    return providerRequest<T>({
      provider: "RAZORPAY",
      method,
      path,
      authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(refundIdempotencyKey ? { idempotencyKey: refundIdempotencyKey, idempotencyHeader: "X-Refund-Idempotency" as const } : {}),
    });
  }

  async testConnection() {
    await this.call("GET", "/v1/payments?count=1");
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    if (!assertCheckoutWindow("RAZORPAY", request.expiresAt)) throw new PaymentsUnavailable("The payment link expiry is outside Razorpay's window.");
    // Razorpay charges one total; the order's lines are named in the description.
    const lines = request.lines.length > 1 ? `: ${request.lines.map((line) => line.name).join(", ")}` : "";
    const result = await this.call("POST", "/v1/payment_links", {
      amount: Number(request.amountMinor),
      currency: request.currency,
      accept_partial: false,
      expire_by: Math.ceil(request.expiresAt.getTime() / 1000),
      // Unique per link, as Razorpay requires: our checkout attempt id.
      reference_id: request.reference,
      description: `${request.description}${lines}`.slice(0, 2048),
      ...(request.customerEmail ? { customer: { email: request.customerEmail } } : {}),
      // Space Works Events sends its own receipts and reminders.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { attempt_id: request.reference },
      callback_url: request.returnUrl,
      callback_method: "get",
    });
    const checkoutId = result.id;
    const checkoutUrl = result.short_url;
    if (!isProviderId(checkoutId) || typeof checkoutUrl !== "string" || !/^https?:\/\//.test(checkoutUrl)) {
      throw new PaymentsUnavailable("Razorpay did not return a payment link.");
    }
    return { checkoutId, checkoutUrl };
  }

  async getCheckoutStatus(checkoutId: string): Promise<CheckoutStatus> {
    if (!isProviderId(checkoutId)) throw new PaymentsUnavailable("Invalid Razorpay link id.");
    const link = await this.call("GET", `/v1/payment_links/${checkoutId}`);
    if (link.status === "paid") {
      const payments = Array.isArray(link.payments) ? link.payments.map(record) : [];
      const captured = payments.find((payment) => payment.status === "captured" && isProviderId(payment.payment_id));
      if (captured) {
        return {
          state: "paid",
          paymentId: captured.payment_id as string,
          amountMinor: parseMinorAmount(captured.amount),
          currency: upperCurrency(link.currency),
        };
      }
      return { state: "open" };
    }
    if (link.status === "cancelled" || link.status === "expired") return { state: "closed" };
    return { state: "open" };
  }

  async cancelCheckout(checkoutId: string): Promise<CheckoutStatus> {
    if (!isProviderId(checkoutId)) throw new PaymentsUnavailable("Invalid Razorpay link id.");
    try {
      await this.call("POST", `/v1/payment_links/${checkoutId}/cancel`);
      return { state: "closed" };
    } catch (error) {
      // A paid, expired or already cancelled link cannot be cancelled; ask
      // Razorpay what happened rather than guessing.
      if (error instanceof PaymentsUnavailable && error.status === 400) {
        const status = await this.getCheckoutStatus(checkoutId);
        if (status.state !== "open") return status;
      }
      throw error;
    }
  }

  async createRefund(request: RefundRequest): Promise<RefundResult> {
    if (!isProviderId(request.paymentId)) throw new PaymentsUnavailable("The payment has no Razorpay payment id to refund.");
    const result = await this.call("POST", `/v1/payments/${request.paymentId}/refund`, {
      amount: Number(request.amountMinor),
      speed: "normal",
      receipt: request.reference.slice(0, 40),
      notes: { refund_id: request.reference },
    }, refundIdempotencyKey(request.idempotencyKey));
    if (!isProviderId(result.id)) throw new PaymentsUnavailable("Razorpay did not return a refund id.");
    return { refundId: result.id, state: REFUND_STATES[String(result.status)] ?? "PENDING" };
  }

  async getPaymentMethod(paymentId: string) {
    if (!isProviderId(paymentId)) throw new PaymentsUnavailable("Invalid Razorpay payment id.");
    const payment = await this.call("GET", `/v1/payments/${paymentId}?expand[]=card`);
    const card = record(payment.card);
    return describePaymentMethod({ type: payment.method, brand: card.network, last4: card.last4, vpa: payment.vpa, bank: payment.bank, wallet: payment.wallet });
  }

  /**
   * Every refund on the payment, page by page. A lookup that can't read them
   * all throws (unknown), so a missing match never licenses a second refund.
   */
  async findRefund(paymentId: string, reference: string): Promise<RefundResult | null> {
    if (!isProviderId(paymentId)) throw new PaymentsUnavailable("Invalid Razorpay payment id.");
    for (let page = 0; page < REFUND_LOOKUP_PAGES; page += 1) {
      const list = await this.call("GET", `/v1/payments/${paymentId}/refunds?count=${REFUND_PAGE_SIZE}&skip=${page * REFUND_PAGE_SIZE}`);
      if (!Array.isArray(list.items)) throw new PaymentsUnavailable("Razorpay sent an unreadable refund list.");
      const items = list.items.map(record);
      const match = items.find((item) => record(item.notes).refund_id === reference && isProviderId(item.id));
      if (match) return { refundId: match.id as string, state: REFUND_STATES[String(match.status)] ?? "PENDING" };
      if (items.length < REFUND_PAGE_SIZE) return null;
    }
    throw new PaymentsUnavailable("Too many Razorpay refunds to look through.");
  }

  async getRefundStatus(paymentId: string, refundId: string): Promise<RefundState> {
    if (!isProviderId(paymentId) || !isProviderId(refundId)) throw new PaymentsUnavailable("Invalid Razorpay refund id.");
    const refund = await this.call("GET", `/v1/payments/${paymentId}/refunds/${refundId}`);
    if (refund.id !== refundId) throw new PaymentsUnavailable("Razorpay sent an unreadable refund.");
    return REFUND_STATES[String(refund.status)] ?? "PENDING";
  }
}

const REFUND_PAGE_SIZE = 100;
const REFUND_LOOKUP_PAGES = 20;

/**
 * Razorpay's X-Refund-Idempotency takes letters, digits, "_" and "-" only:
 * our `refund:<id>` key, made safe the same way every time.
 */
export function refundIdempotencyKey(key: string) {
  return key.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}

/**
 * Verify X-Razorpay-Signature (hex HMAC-SHA256 of the raw body with the
 * organisation's webhook secret) and normalise the event. Throws
 * WebhookVerificationError for anything unsigned, mis-signed or unparseable.
 */
export function verifyRazorpayWebhook(secret: string, rawBody: Buffer, headers: Headers): VerifiedWebhookEvent {
  const signature = headers.get("x-razorpay-signature")?.trim() ?? "";
  if (!secret || !signature || !safeEqualHex(hmacSha256Hex(secret, rawBody), signature)) throw new WebhookVerificationError();
  let body: Entity;
  try {
    body = record(JSON.parse(rawBody.toString("utf8")));
  } catch {
    throw new WebhookVerificationError();
  }
  const eventType = typeof body.event === "string" ? body.event : "";
  const payload = record(body.payload);
  const link = record(record(payload.payment_link).entity);
  const payment = record(record(payload.payment).entity);
  const order = record(record(payload.order).entity);
  const refund = record(record(payload.refund).entity);

  // Razorpay has no event id in the body; the delivery header is the
  // idempotency key. Without it, the entity ids keep one record per change.
  const headerId = headers.get("x-razorpay-event-id")?.trim();
  const eventId = headerId && headerId.length <= 128
    ? headerId
    : `${eventType}:${text(refund.id) ?? text(link.id) ?? text(payment.id) ?? text(order.id) ?? ""}:${String(body.created_at ?? "")}`;

  let paid: VerifiedWebhookEvent["paid"] = null;
  if (RAZORPAY_PAID_EVENTS.has(eventType) && isProviderId(payment.id) && (eventType !== "payment.captured" || payment.status === "captured")) {
    const notes = record(payment.notes);
    const linkNotes = record(link.notes);
    paid = {
      checkoutId: isProviderId(link.id) ? link.id : null,
      reference: text(link.reference_id) ?? text(linkNotes.attempt_id) ?? text(notes.attempt_id) ?? text(record(order.notes).attempt_id),
      paymentId: payment.id,
      amountMinor: parseMinorAmount(payment.amount),
      currency: upperCurrency(payment.currency),
    };
  }

  const refunds: RefundNotification[] = [];
  if (RAZORPAY_REFUND_EVENTS.has(eventType) && isProviderId(refund.id)) {
    refunds.push({
      refundId: refund.id,
      paymentId: isProviderId(refund.payment_id) ? refund.payment_id : null,
      reference: text(record(refund.notes).refund_id),
      state: eventType === "refund.failed" ? "FAILED" : REFUND_STATES[String(refund.status)] ?? "PENDING",
      amountMinor: parseMinorAmount(refund.amount),
    });
  }

  const closedCheckoutId = (eventType === "payment_link.expired" || eventType === "payment_link.cancelled") && isProviderId(link.id) ? link.id : null;

  // payment.dispute.created / under_review / action_required / won / lost / closed
  const disputeEntity = record(record(payload.dispute).entity);
  let dispute: DisputeNotification | null = null;
  if (eventType.startsWith("payment.dispute.") && isProviderId(disputeEntity.id) && isProviderId(disputeEntity.payment_id)) {
    const status = String(disputeEntity.status ?? eventType.slice("payment.dispute.".length));
    const respondBy = typeof disputeEntity.respond_by === "number" ? new Date(disputeEntity.respond_by * 1000) : null;
    dispute = {
      disputeId: disputeEntity.id,
      paymentId: disputeEntity.payment_id,
      status: status === "won" ? "WON" : status === "lost" ? "LOST" : status === "closed" ? "CLOSED" : status === "under_review" ? "UNDER_REVIEW" : "OPEN",
      amountMinor: parseMinorAmount(disputeEntity.amount),
      currency: upperCurrency(disputeEntity.currency),
      reason: text(disputeEntity.reason_code) ?? text(disputeEntity.reason_description),
      respondBy: respondBy && !Number.isNaN(respondBy.getTime()) ? respondBy : null,
    };
  }

  return { eventId, eventType: eventType.slice(0, 80), paid, refunds, closedCheckoutId, dispute };
}

/** Razorpay key ids are public; their prefix says whether the account is in test mode. */
export function isRazorpayTestKey(keyId: string) {
  return keyId.startsWith("rzp_test_");
}
