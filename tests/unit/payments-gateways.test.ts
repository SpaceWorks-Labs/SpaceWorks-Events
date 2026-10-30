import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PaymentsUnavailable, providerApiRoot } from "@/lib/payments/http";
import { RazorpayGateway } from "@/lib/payments/providers/razorpay";
import { StripeGateway } from "@/lib/payments/providers/stripe";

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const checkout = {
  reference: "payref1",
  amountMinor: BigInt(49900),
  currency: "INR",
  description: "Space Works Meetup",
  lines: [{ name: "General admission × 1", amountMinor: BigInt(49900) }],
  returnUrl: "https://events.example/ticket/token?payment=return",
  cancelUrl: "https://events.example/ticket/token?payment=cancelled",
  expiresAt: new Date(Date.now() + 32 * 60_000),
  customerEmail: "guest@example.test",
  idempotencyKey: "checkout:payref1:1",
};

describe("provider base URL override", () => {
  it("uses the real provider APIs by default", () => {
    expect(providerApiRoot("RAZORPAY")).toBe("https://api.razorpay.com");
    expect(providerApiRoot("STRIPE")).toBe("https://api.stripe.com");
  });

  it("allows a loopback fake outside production", () => {
    vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", "http://127.0.0.1:4010");
    expect(providerApiRoot("STRIPE")).toBe("http://127.0.0.1:4010/stripe");
  });

  it("refuses the override in production and for non-loopback hosts", () => {
    vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", "http://127.0.0.1:4010");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => providerApiRoot("RAZORPAY")).toThrow(/not allowed in production/);
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", "http://attacker.example");
    expect(() => providerApiRoot("RAZORPAY")).toThrow(/loopback/);
    vi.stubEnv("PAYMENTS_FAKE_PROVIDER_URL", "https://127.0.0.1:4010/path");
    expect(() => providerApiRoot("RAZORPAY")).toThrow(/loopback/);
  });
});

describe("Razorpay gateway", () => {
  const gateway = new RazorpayGateway("rzp_test_abcdef", "secretvalue");

  it("creates a payment link with integer paise, our reference and its own notifications off", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "plink_1", short_url: "https://rzp.io/i/abc" }));
    await expect(gateway.createCheckout(checkout)).resolves.toEqual({ checkoutId: "plink_1", checkoutUrl: "https://rzp.io/i/abc" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/payment_links");
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("rzp_test_abcdef:secretvalue").toString("base64")}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ amount: 49900, currency: "INR", reference_id: "payref1", accept_partial: false, notify: { sms: false, email: false }, reminder_enable: false, callback_method: "get", notes: { attempt_id: "payref1" } });
    expect(Number.isInteger(body.amount)).toBe(true);
    expect(body.expire_by).toBe(Math.ceil(checkout.expiresAt.getTime() / 1000));
  });

  it("refuses a link that would expire sooner than Razorpay allows", async () => {
    await expect(gateway.createCheckout({ ...checkout, expiresAt: new Date(Date.now() + 5 * 60_000) })).rejects.toBeInstanceOf(PaymentsUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds a refund it already made by our reference", async () => {
    fetchMock.mockResolvedValue(reply(200, { items: [{ id: "rfnd_other", notes: { refund_id: "x" }, status: "processed" }, { id: "rfnd_ours", notes: { refund_id: "refund1" }, status: "pending" }] }));
    await expect(gateway.findRefund("pay_1", "refund1")).resolves.toEqual({ refundId: "rfnd_ours", state: "PENDING" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.razorpay.com/v1/payments/pay_1/refunds?count=100&skip=0");
  });

  it("looks through every page of refunds, and treats a lookup it can't finish as unknown", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: `rfnd_other${index}`, notes: { refund_id: `x${index}` }, status: "processed" }));
    fetchMock
      .mockResolvedValueOnce(reply(200, { items: others }))
      .mockResolvedValueOnce(reply(200, { items: [{ id: "rfnd_ours", notes: { refund_id: "refund1" }, status: "processed" }] }));
    await expect(gateway.findRefund("pay_1", "refund1")).resolves.toEqual({ refundId: "rfnd_ours", state: "SUCCEEDED" });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.razorpay.com/v1/payments/pay_1/refunds?count=100&skip=100");
    // A short last page without ours: there is none.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { items: others })).mockResolvedValueOnce(reply(200, { items: [] }));
    await expect(gateway.findRefund("pay_1", "refund1")).resolves.toBeNull();
    // An unreadable page, or more pages than it reads, is never "not found".
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { error: "nope" }));
    await expect(gateway.findRefund("pay_1", "refund1")).rejects.toBeInstanceOf(PaymentsUnavailable);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => reply(200, { items: others }));
    await expect(gateway.findRefund("pay_1", "refund1")).rejects.toBeInstanceOf(PaymentsUnavailable);
  });

  it("sends Razorpay's refund idempotency header with a key it accepts, stable per refund", async () => {
    fetchMock.mockImplementation(async () => reply(200, { id: "rfnd_1", status: "pending" }));
    const request = { paymentId: "pay_1", amountMinor: BigInt(1000), currency: "INR", reference: "cmrefund1", idempotencyKey: "refund:cmrefund1" };
    await gateway.createRefund(request);
    await gateway.createRefund(request);
    const [first, second] = fetchMock.mock.calls.map((call) => call[1].headers as Record<string, string>);
    expect(first!["X-Refund-Idempotency"]).toBe("refund_cmrefund1");
    expect(first!["X-Refund-Idempotency"]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(second!["X-Refund-Idempotency"]).toBe(first!["X-Refund-Idempotency"]);
    expect(first!["Idempotency-Key"]).toBeUndefined();
  });

  it("reads one refund's status, and never reads a timeout as failed", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: "rfnd_1", status: "failed" }));
    await expect(gateway.getRefundStatus("pay_1", "rfnd_1")).resolves.toBe("FAILED");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.razorpay.com/v1/payments/pay_1/refunds/rfnd_1");
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(gateway.getRefundStatus("pay_1", "rfnd_1")).rejects.toBeInstanceOf(PaymentsUnavailable);
  });

  it("reports a paid link when cancelling finds the attendee already paid", async () => {
    fetchMock
      .mockResolvedValueOnce(reply(400, { error: { code: "BAD_REQUEST_ERROR", description: "Payment link already paid" } }))
      .mockResolvedValueOnce(reply(200, { status: "paid", currency: "INR", payments: [{ payment_id: "pay_1", amount: 49900, status: "captured" }] }));
    await expect(gateway.cancelCheckout("plink_1")).resolves.toEqual({ state: "paid", paymentId: "pay_1", amountMinor: BigInt(49900), currency: "INR" });
  });

  it("refuses to interpolate unsafe ids into API paths", async () => {
    await expect(gateway.getCheckoutStatus("../payments")).rejects.toBeInstanceOf(PaymentsUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("wraps network failures and never exposes the provider message", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED with secret in message"));
    const error = await gateway.testConnection().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentsUnavailable);
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("maps refund status", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "rfnd_1", status: "processed" }));
    await expect(gateway.createRefund({ paymentId: "pay_1", amountMinor: BigInt(1000), currency: "INR", reference: "refund1", idempotencyKey: "refund:refund1" }))
      .resolves.toEqual({ refundId: "rfnd_1", state: "SUCCEEDED" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ amount: 1000, notes: { refund_id: "refund1" } });
  });
});

describe("Stripe gateway", () => {
  const gateway = new StripeGateway("sk_test_abcdefghijkl");

  it("creates a Checkout Session as form data with an idempotency key and a valid expiry", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }));
    await gateway.createCheckout(checkout);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(init.headers.Authorization).toBe("Bearer sk_test_abcdefghijkl");
    expect(init.headers["Idempotency-Key"]).toBe("checkout:payref1:1");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("49900");
    expect(form.get("line_items[0][price_data][currency]")).toBe("inr");
    expect(form.get("line_items[0][price_data][product_data][name]")).toBe("General admission × 1");
    expect(form.get("client_reference_id")).toBe("payref1");
    expect(form.get("metadata[attempt_id]")).toBe("payref1");
    expect(Number(form.get("expires_at"))).toBe(Math.floor(checkout.expiresAt.getTime() / 1000));
  });

  it("sends one item per order line and refuses lines that don't add up to the total", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "cs_test_2", url: "https://checkout.stripe.com/c/pay/cs_test_2" }));
    await gateway.createCheckout({ ...checkout, amountMinor: BigInt(129900), lines: [{ name: "General × 2", amountMinor: BigInt(99800) }, { name: "Workshop kit", amountMinor: BigInt(30100) }] });
    const form = new URLSearchParams(fetchMock.mock.calls[0]![1].body);
    expect(form.get("line_items[1][price_data][unit_amount]")).toBe("30100");
    expect(form.get("line_items[1][quantity]")).toBe("1");
    await expect(gateway.createCheckout({ ...checkout, amountMinor: BigInt(1) })).rejects.toBeInstanceOf(PaymentsUnavailable);
  });

  it("refuses an expiry outside Stripe's 30-minute to 24-hour window", async () => {
    await expect(gateway.createCheckout({ ...checkout, expiresAt: new Date(Date.now() + 20 * 60_000) })).rejects.toBeInstanceOf(PaymentsUnavailable);
    await expect(gateway.createCheckout({ ...checkout, expiresAt: new Date(Date.now() + 25 * 3600_000) })).rejects.toBeInstanceOf(PaymentsUnavailable);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats only a complete and paid session as paid", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { status: "complete", payment_status: "unpaid", payment_intent: "pi_1" }));
    await expect(gateway.getCheckoutStatus("cs_test_1")).resolves.toEqual({ state: "open" });
    fetchMock.mockResolvedValueOnce(reply(200, { status: "complete", payment_status: "paid", payment_intent: { id: "pi_1" }, amount_total: 49900, currency: "inr" }));
    await expect(gateway.getCheckoutStatus("cs_test_1")).resolves.toEqual({ state: "paid", paymentId: "pi_1", amountMinor: BigInt(49900), currency: "INR" });
  });

  it("looks through every page of refunds by cursor, and treats a lookup it can't finish as unknown", async () => {
    const others = Array.from({ length: 100 }, (_, index) => ({ id: `re_other${index}`, metadata: { refund_id: `x${index}` }, status: "succeeded" }));
    fetchMock
      .mockResolvedValueOnce(reply(200, { data: others, has_more: true }))
      .mockResolvedValueOnce(reply(200, { data: [{ id: "re_ours", metadata: { refund_id: "refund1" }, status: "pending" }], has_more: false }));
    await expect(gateway.findRefund("pi_1", "refund1")).resolves.toEqual({ refundId: "re_ours", state: "PENDING" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.stripe.com/v1/refunds?payment_intent=pi_1&limit=100");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.stripe.com/v1/refunds?payment_intent=pi_1&limit=100&starting_after=re_other99");
    // The last page without ours: there is none.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(200, { data: others, has_more: true })).mockResolvedValueOnce(reply(200, { data: [], has_more: false }));
    await expect(gateway.findRefund("pi_1", "refund1")).resolves.toBeNull();
    // A malformed page (no list, no has_more, a bad id) or more pages than it reads is never "not found".
    for (const body of [{ error: "nope" }, { data: others }, { data: [{ id: "bad id!", metadata: {} }], has_more: false }]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(reply(200, body));
      await expect(gateway.findRefund("pi_1", "refund1")).rejects.toBeInstanceOf(PaymentsUnavailable);
    }
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => reply(200, { data: others, has_more: true }));
    await expect(gateway.findRefund("pi_1", "refund1")).rejects.toBeInstanceOf(PaymentsUnavailable);
    // A refusal (for example 401 while the keys are wrong) is unknown too.
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(reply(401, { error: { code: "invalid_api_key" } }));
    await expect(gateway.findRefund("pi_1", "refund1")).rejects.toMatchObject({ status: 401 });
  });

  it("reads one refund's status by its id", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { id: "re_1", status: "succeeded" }));
    await expect(gateway.getRefundStatus("pi_1", "re_1")).resolves.toBe("SUCCEEDED");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.stripe.com/v1/refunds/re_1");
  });

  it("expires an open session and reports closed", async () => {
    fetchMock.mockResolvedValue(reply(200, { id: "cs_test_1", status: "expired" }));
    await expect(gateway.cancelCheckout("cs_test_1")).resolves.toEqual({ state: "closed" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.stripe.com/v1/checkout/sessions/cs_test_1/expire");
  });

  it("surfaces an unknown cancellation outcome instead of guessing", async () => {
    fetchMock.mockResolvedValue(reply(500, {}));
    await expect(gateway.cancelCheckout("cs_test_1")).rejects.toMatchObject({ status: 500 });
  });
});
