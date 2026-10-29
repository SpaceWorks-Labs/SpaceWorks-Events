import "server-only";

/**
 * The provider is unreachable, unconfigured, or refused the request. Callers
 * treat it as "no checkout/refund yet", never as a failed domain action, and
 * never show its message to people: provider bodies can echo names and notes.
 */
export class PaymentsUnavailable extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = "PaymentsUnavailable";
  }
}

const API_ROOTS = {
  RAZORPAY: "https://api.razorpay.com",
  STRIPE: "https://api.stripe.com",
} as const;

export type OnlineProvider = keyof typeof API_ROOTS;

const TIMEOUT_MS = 15_000;

/**
 * Tests point every provider call at a local fake through
 * PAYMENTS_FAKE_PROVIDER_URL. The override only accepts a loopback HTTP
 * origin and is refused outright in production, so a misconfigured server
 * can never send keys or payment requests anywhere but the real provider.
 */
export function providerApiRoot(provider: OnlineProvider): string {
  const override = process.env.PAYMENTS_FAKE_PROVIDER_URL?.trim();
  if (!override) return API_ROOTS[provider];
  if (process.env.NODE_ENV === "production") throw new Error("PAYMENTS_FAKE_PROVIDER_URL is not allowed in production.");
  const url = new URL(override);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.origin !== override.replace(/\/$/, "")) {
    throw new Error("PAYMENTS_FAKE_PROVIDER_URL must be a loopback http origin.");
  }
  return `${url.origin}/${provider.toLowerCase()}`;
}

type ProviderRequest = {
  provider: OnlineProvider;
  method: "GET" | "POST";
  path: string;
  authorization: string;
  body?: string;
  contentType?: string;
  idempotencyKey?: string;
  /** The header that carries `idempotencyKey`: Stripe's Idempotency-Key, or Razorpay's X-Refund-Idempotency for refunds. */
  idempotencyHeader?: "Idempotency-Key" | "X-Refund-Idempotency";
};

/** One JSON request to a provider API. Never logs bodies, keys or URLs with ids. */
export async function providerRequest<T = Record<string, unknown>>(request: ProviderRequest): Promise<T> {
  const headers: Record<string, string> = { Authorization: request.authorization, Accept: "application/json" };
  if (request.body !== undefined) headers["Content-Type"] = request.contentType ?? "application/json";
  if (request.idempotencyKey) headers[request.idempotencyHeader ?? "Idempotency-Key"] = request.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`${providerApiRoot(request.provider)}${request.path}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    console.warn(`[payments] ${request.provider.toLowerCase()} unreachable`);
    throw new PaymentsUnavailable("The payment provider could not be reached.");
  }
  let parsed: unknown = null;
  try {
    const text = await response.text();
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    console.warn(`[payments] ${request.provider.toLowerCase()} rejected a request (${response.status})`);
    throw new PaymentsUnavailable("The payment provider rejected the request.", response.status, providerErrorCode(parsed));
  }
  if (!parsed || typeof parsed !== "object") throw new PaymentsUnavailable("The payment provider sent an unreadable response.");
  return parsed as T;
}

/** A provider's machine-readable error code, never its human message. */
function providerErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("error" in body)) return undefined;
  const error = (body as { error: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : undefined;
}
