import crypto from "node:crypto";

/**
 * An in-process stand-in for the Razorpay and Stripe APIs, for integration
 * tests. Install it as `fetch` with PAYMENTS_FAKE_PROVIDER_URL pointing at
 * FAKE_PROVIDER_ORIGIN; it records every request and keeps pages in memory.
 */
export const FAKE_PROVIDER_ORIGIN = "http://127.0.0.1:9";

type Page = { provider: "razorpay" | "stripe"; id: string; reference: string; amount: number; currency: string; status: "open" | "paid" | "closed"; paymentId?: string; expiresAt: number; lines: string[]; };

export function createFakeProvider() {
  const pages = new Map<string, Page>();
  const requests: Array<{ provider: string; method: string; path: string; body: string; headers: Record<string, string>; }> = [];
  const refunds: Array<{ id: string; paymentId: string; amount: number; reference: string; status: string; }> = [];
  let sequence = 0;
  let failNext: number | null = null;
  let unreachableNext = false;
  /** The provider's status for refunds it creates: "processed"/"succeeded" unless a test says "pending". */
  let newRefundStatus: "done" | "pending" = "done";
  const id = (prefix: string) => `${prefix}_${(sequence += 1).toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  async function handle(url: URL, init: RequestInit): Promise<Response> {
    const [, providerName, ...rest] = url.pathname.split("/");
    const provider = providerName as "razorpay" | "stripe";
    const path = `/${rest.join("/")}`;
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    requests.push({ provider, method, path: `${path}${url.search}`, body, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    if (unreachableNext) {
      unreachableNext = false;
      throw new TypeError("fetch failed");
    }
    if (failNext) {
      const status = failNext;
      failNext = null;
      return json(status, { error: { code: "FAKE_FAILURE" } });
    }
    if (provider === "razorpay") {
      if (method === "GET" && path === "/v1/payments") return json(200, { items: [] });
      const paid = path.match(/^\/v1\/payments\/(\w+)$/);
      if (method === "GET" && paid) return json(200, { id: paid[1], method: "card", card: { network: "Visa", last4: "4242" } });
      if (method === "POST" && path === "/v1/payment_links") {
        const data = JSON.parse(body);
        const page: Page = { provider, id: id("plink"), reference: data.reference_id, amount: data.amount, currency: data.currency, status: "open", expiresAt: data.expire_by, lines: [data.description] };
        pages.set(page.id, page);
        return json(200, { id: page.id, short_url: `https://rzp.example/i/${page.id}` });
      }
      const link = path.match(/^\/v1\/payment_links\/(\w+)(\/cancel)?$/);
      if (link) {
        const page = pages.get(link[1]!);
        if (!page) return json(404, {});
        if (link[2]) {
          if (page.status !== "open") return json(400, { error: { code: "BAD_REQUEST_ERROR" } });
          page.status = "closed";
        }
        return json(200, { id: page.id, status: page.status === "open" ? "created" : page.status === "paid" ? "paid" : "cancelled", currency: page.currency, payments: page.paymentId ? [{ payment_id: page.paymentId, amount: page.amount, status: "captured" }] : [] });
      }
      const one = path.match(/^\/v1\/payments\/(\w+)\/refunds\/(\w+)$/);
      if (one && method === "GET") {
        const found = refunds.find((item) => item.paymentId === one[1] && item.id === one[2]);
        return found ? json(200, { id: found.id, status: found.status }) : json(404, { error: { code: "BAD_REQUEST_ERROR" } });
      }
      const refund = path.match(/^\/v1\/payments\/(\w+)\/refunds?$/);
      if (refund && method === "POST") {
        const data = JSON.parse(body);
        const created = { id: id("rfnd"), paymentId: refund[1]!, amount: data.amount, reference: data.notes?.refund_id, status: newRefundStatus === "pending" ? "pending" : "processed" };
        refunds.push(created);
        return json(200, { id: created.id, status: created.status });
      }
      if (refund) {
        const count = Number(url.searchParams.get("count") ?? 10);
        const skip = Number(url.searchParams.get("skip") ?? 0);
        const items = refunds.filter((item) => item.paymentId === refund[1]).slice(skip, skip + count);
        return json(200, { items: items.map((item) => ({ id: item.id, status: item.status, notes: { refund_id: item.reference } })) });
      }
    } else {
      const form = new URLSearchParams(body);
      if (method === "GET" && path === "/v1/balance") return json(200, {});
      if (method === "POST" && path === "/v1/checkout/sessions") {
        const amounts = [...form.keys()].filter((key) => /unit_amount\]$/.test(key)).map((key) => Number(form.get(key)));
        const page: Page = {
          provider, id: id("cs_test"), reference: form.get("client_reference_id")!, amount: amounts.reduce((a, b) => a + b, 0), currency: form.get("line_items[0][price_data][currency]")!,
          status: "open", expiresAt: Number(form.get("expires_at")), lines: [...form.keys()].filter((key) => /product_data\]\[name\]$/.test(key)).map((key) => form.get(key)!),
        };
        pages.set(page.id, page);
        return json(200, { id: page.id, url: `https://checkout.stripe.example/${page.id}` });
      }
      const session = path.match(/^\/v1\/checkout\/sessions\/(\w+)(\/expire)?$/);
      if (session) {
        const page = pages.get(session[1]!);
        if (!page) return json(404, {});
        if (session[2]) {
          if (page.status !== "open") return json(400, { error: { code: "checkout_session_not_open" } });
          page.status = "closed";
        }
        return json(200, { id: page.id, status: page.status === "open" ? "open" : page.status === "paid" ? "complete" : "expired", payment_status: page.status === "paid" ? "paid" : "unpaid", payment_intent: page.paymentId ?? null, amount_total: page.amount, currency: page.currency });
      }
      const intent = path.match(/^\/v1\/payment_intents\/(\w+)$/);
      if (method === "GET" && intent) return json(200, { id: intent[1], latest_charge: { payment_method_details: { type: "upi", upi: { vpa: "buyer@okicici" } } } });
      if (method === "POST" && path === "/v1/refunds") {
        const created = { id: id("re"), paymentId: form.get("payment_intent")!, amount: Number(form.get("amount")), reference: form.get("metadata[refund_id]")!, status: newRefundStatus === "pending" ? "pending" : "succeeded" };
        refunds.push(created);
        return json(200, { id: created.id, status: created.status });
      }
      if (method === "GET" && path === "/v1/refunds") return json(200, { data: refunds.filter((item) => item.paymentId === url.searchParams.get("payment_intent")).map((item) => ({ id: item.id, status: item.status, metadata: { refund_id: item.reference } })) });
      const stripeRefund = path.match(/^\/v1\/refunds\/(\w+)$/);
      if (method === "GET" && stripeRefund) {
        const found = refunds.find((item) => item.id === stripeRefund[1]);
        return found ? json(200, { id: found.id, status: found.status }) : json(404, { error: { code: "resource_missing" } });
      }
    }
    return json(404, { error: { code: "NOT_FOUND" } });
  }

  return {
    pages,
    requests,
    refunds,
    /** The next provider call answers with this HTTP status. */
    failNextWith(status: number) { failNext = status; },
    /** The next provider call never gets an answer (a timeout or a dropped connection). */
    dropNext() { unreachableNext = true; },
    /** Refunds created from now on stay pending at the provider ("done" settles them at once). */
    refundsSettle(mode: "done" | "pending") { newRefundStatus = mode; },
    /** The buyer pays a page; returns the provider payment id. */
    pay(pageId: string) {
      const page = pages.get(pageId)!;
      page.status = "paid";
      page.paymentId = page.provider === "razorpay" ? id("pay") : id("pi");
      return page.paymentId;
    },
    fetch: async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== FAKE_PROVIDER_ORIGIN) throw new Error(`Unexpected request to ${url.origin}`);
      return handle(url, init);
    },
  };
}

/** A signed webhook request for the page, as each provider sends it. */
export function signedPaidWebhook(page: { provider: "razorpay" | "stripe"; id: string; reference: string; amount: number; currency: string; paymentId?: string; }, secret: string, path: string) {
  if (page.provider === "razorpay") {
    const raw = JSON.stringify({
      event: "payment_link.paid",
      payload: { payment_link: { entity: { id: page.id, reference_id: page.reference } }, payment: { entity: { id: page.paymentId, amount: page.amount, currency: page.currency.toUpperCase(), status: "captured" } } },
    });
    return new Request(`http://localhost${path}`, { method: "POST", body: raw, headers: { "x-razorpay-signature": crypto.createHmac("sha256", secret).update(raw).digest("hex"), "x-razorpay-event-id": `evt_${page.id}` } });
  }
  const raw = JSON.stringify({ id: `evt_${page.id}`, type: "checkout.session.completed", data: { object: { id: page.id, client_reference_id: page.reference, payment_status: "paid", payment_intent: page.paymentId, amount_total: page.amount, currency: page.currency } } });
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(`http://localhost${path}`, { method: "POST", body: raw, headers: { "stripe-signature": `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}` } });
}

/** Any webhook body, signed as each provider signs it. */
export function signedWebhook(provider: "razorpay" | "stripe", body: Record<string, unknown>, secret: string, path: string, eventId: string) {
  if (provider === "razorpay") {
    const raw = JSON.stringify(body);
    return new Request(`http://localhost${path}`, { method: "POST", body: raw, headers: { "x-razorpay-signature": crypto.createHmac("sha256", secret).update(raw).digest("hex"), "x-razorpay-event-id": eventId } });
  }
  const raw = JSON.stringify({ id: eventId, ...body });
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(`http://localhost${path}`, { method: "POST", body: raw, headers: { "stripe-signature": `t=${timestamp},v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}` } });
}
