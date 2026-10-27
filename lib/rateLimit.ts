import type { NextRequest } from "next/server";
import Redis from "ioredis";
import { REDIS_FAIL_FAST_OPTIONS } from "@/lib/redisOptions";

export type Bucket =
  | "global"
  | "action"
  | "frontendAction"
  | "create"
  | "auth"
  | "signup"
  | "emailVerification"
  | "passwordReset"
  | "rsvp"
  | "feedback"
  | "upload"
  | "invite"
  | "broadcast"
  | "broadcastTest"
  | "broadcastDraft"
  | "designAutosave"
  | "ticketRender"
  | "checkin"
  | "checkinStationPin"
  | "search"
  | "apiRead"
  | "apiWrite"
  | "dataExport"
  | "ticketStatus"
  | "ticketEvents"
  | "shortLink"
  | "paymentWebhook"
  | "loginFailureIp"
  | "loginFailureAccount"
  | "loginCode"
  | "paymentSettings"
  | "paymentStatus"
  | "ticketCheckout"
  | "clientError"
  | "webhookManage"
  | "webhookTest";

const limits: Record<Bucket, { max: number; windowMs: number; }> = {
  global: { max: 300, windowMs: 60_000 },
  action: { max: 180, windowMs: 60_000 },
  frontendAction: { max: 180, windowMs: 60_000 },
  create: { max: 20, windowMs: 60 * 60_000 },
  auth: { max: 10, windowMs: 60_000 },
  signup: { max: 5, windowMs: 60 * 60_000 },
  emailVerification: { max: 5, windowMs: 60 * 60_000 },
  passwordReset: { max: 5, windowMs: 60 * 60_000 },
  rsvp: { max: 10, windowMs: 60_000 },
  feedback: { max: 8, windowMs: 60_000 },
  upload: { max: 12, windowMs: 60 * 60_000 },
  invite: { max: 30, windowMs: 60 * 60_000 },
  broadcast: { max: 10, windowMs: 60 * 60_000 },
  // Tests only reach the organiser's own inbox; kept apart so testing never blocks the real send.
  broadcastTest: { max: 20, windowMs: 60 * 60_000 },
  // Draft autosave and discard in the Emails tab. Saves fire about 1.5s after
  // typing stops, so a steady writer stays well under this.
  broadcastDraft: { max: 60, windowMs: 60_000 },
  // Ticket designer autosave (docs/TICKET_DESIGNER.md): about 1.5s after each edit stops.
  designAutosave: { max: 90, windowMs: 60_000 },
  // Designed ticket images and PDFs (docs/TICKET_DESIGNER.md): each is a fresh server render.
  ticketRender: { max: 20, windowMs: 60_000 },
  checkin: { max: 180, windowMs: 60_000 },
  checkinStationPin: { max: 5, windowMs: 60_000 },
  search: { max: 60, windowMs: 60_000 },
  apiRead: { max: 600, windowMs: 60_000 },
  apiWrite: { max: 60, windowMs: 60_000 },
  dataExport: { max: 5, windowMs: 60 * 60_000 },
  // Public ticket check-in state. Attendees at one venue often share a NAT
  // address, so these stay generous while still bounding polling/reconnects.
  ticketStatus: { max: 120, windowMs: 60_000 },
  ticketEvents: { max: 60, windowMs: 60_000 },
  // Public short-link lookups. Kept tight so the code space cannot be scanned.
  shortLink: { max: 30, windowMs: 60_000 },
  // Provider webhooks arrive from a few shared provider addresses, often in
  // bursts after an outage. Kept out of the global bucket so attendee traffic
  // can never starve settlement, while still bounding a flood.
  paymentWebhook: { max: 600, windowMs: 60_000 },
  // Saving keys and "Test connection" call the provider with the owner's keys.
  paymentSettings: { max: 30, windowMs: 60 * 60_000 },
  // Return-page status reads, per order: the webhook is the authority.
  paymentStatus: { max: 6, windowMs: 60_000 },
  // Failed sign-ins (counted only, see recordFailure): an address with this
  // many in an hour is blocked from signing in until the hour is up.
  loginFailureIp: { max: 20, windowMs: 60 * 60_000 },
  // An account with this many in 15 minutes needs an emailed code even with the right password.
  loginFailureAccount: { max: 5, windowMs: 15 * 60_000 },
  // Sign-in codes emailed to one account.
  loginCode: { max: 5, windowMs: 60 * 60_000 },
  // "Pay now" on a pending order or ticket, per IP.
  ticketCheckout: { max: 20, windowMs: 60_000 },
  // Browser crash reports forwarded to the operator alert webhook.
  clientError: { max: 10, windowMs: 60_000 },
  // Organisation webhook endpoint changes (create, edit, rotate, enable, delete).
  webhookManage: { max: 30, windowMs: 60_000 },
  // Webhook test sends and manual redeliveries each make an outbound request.
  webhookTest: { max: 20, windowMs: 60 * 60_000 },
};

// Local fallback store
type Entry = { count: number; resetAt: number; };
const memoryStore = new Map<string, Entry>();

/** Connection states in which Redis is known to be unavailable right now. */
const UNAVAILABLE_STATES = new Set(["reconnecting", "close", "end"]);

let redisClient: Redis | null = null;
let isRedisDisabled = false;

function allowTestMemoryFallback() {
  return process.env.CI === "true" && process.env.ALLOW_INSECURE_PRODUCTION_TESTS === "1";
}

function getRedisClient(): Redis | null {
  if (isRedisDisabled) return null;
  if (redisClient) return redisClient;

  const redisUrl = process.env.REDIS_URL;
  if (redisUrl === "memory://" && allowTestMemoryFallback()) {
    isRedisDisabled = true;
    return null;
  }
  if (!redisUrl) {
    isRedisDisabled = true;
    return null;
  }

  try {
    redisClient = new Redis(redisUrl, REDIS_FAIL_FAST_OPTIONS);

    redisClient.on("error", () => {
      console.warn("[rateLimit] Redis client error");
    });

    return redisClient;
  } catch {
    console.error("[rateLimit] Redis client initialization failed");
    isRedisDisabled = true;
    return null;
  }
}

function keyFor(bucket: Bucket, id: string) {
  return `ratelimit:${bucket}:${id}`;
}

export function getClientIp(request: NextRequest): string {
  const configuredHeader = process.env.TRUSTED_PROXY_IP_HEADER;
  if (isTrustedProxyHeader(configuredHeader)) return readConfiguredIp(request.headers, configuredHeader);
  return "unknown";
}

export function getClientIpFromHeaders(headers: Headers): string {
  const configuredHeader = process.env.TRUSTED_PROXY_IP_HEADER;
  return isTrustedProxyHeader(configuredHeader) ? readConfiguredIp(headers, configuredHeader) : "unknown";
}

function isTrustedProxyHeader(value: string | undefined): value is "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip" {
  return value === "cf-connecting-ip" || value === "x-forwarded-for" || value === "x-real-ip";
}

function readConfiguredIp(headers: Headers, header: "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip") {
  const value = headers.get(header)?.trim();
  if (!value) return "unknown";
  return header === "x-forwarded-for" ? forwardedClientIp(value) : value;
}

/**
 * The client address in `X-Forwarded-For`. By default the edge is expected to
 * overwrite the header, so the left-most entry is the client. Proxies that
 * append instead (Render) leave client-chosen values on the left; set
 * `TRUSTED_PROXY_HOPS` to the number of trusted proxies to read the entry the
 * outermost trusted proxy added, counted from the right.
 */
function forwardedClientIp(value: string): string {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  const entry = Number.isInteger(hops) && hops > 0 ? entries[Math.max(0, entries.length - hops)] : entries[0];
  return entry || "unknown";
}

function checkRateLimitMemory(bucket: Bucket, id: string): boolean {
  const k = keyFor(bucket, id);
  const { max, windowMs } = limits[bucket];
  const now = Date.now();
  let entry = memoryStore.get(k);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    memoryStore.set(k, entry);
  }
  entry.count += 1;
  return entry.count <= max;
}

/** Returns true if the request is allowed; false if rate limited. */
export async function checkRateLimit(
  request: NextRequest,
  bucket: Bucket,
): Promise<boolean> {
  return checkRateLimitById(bucket, getClientIp(request));
}

/** Check a bucket using a privacy-safe, caller-provided subject key. */
export async function checkRateLimitById(bucket: Bucket, id: string): Promise<boolean> {
  const redis = getRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === "production" && !allowTestMemoryFallback()) return false;
    return checkRateLimitMemory(bucket, id);
  }

  const k = keyFor(bucket, id);
  const { max, windowMs } = limits[bucket];

  // While ioredis is between reconnect attempts, answer at once instead of
  // queueing behind the backoff (production fails closed, as below).
  if (UNAVAILABLE_STATES.has(redis.status)) {
    if (process.env.NODE_ENV === "production" && !allowTestMemoryFallback()) return false;
    return checkRateLimitMemory(bucket, id);
  }

  try {
    // Increment and expiry must be one Redis operation. A pipeline can leave
    // an unexpiring key behind if the process dies between INCR and PEXPIRE.
    const count = await redis.eval(
      "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return c",
      1,
      k,
      String(windowMs),
    );
    return Number(count) <= max;
  } catch {
    console.warn("[rateLimit] Redis check failed");
    if (process.env.NODE_ENV === "production" && !allowTestMemoryFallback()) return false;
    return checkRateLimitMemory(bucket, id);
  }
}

/**
 * Failure counters: `recordFailure` counts one, `failureCount` reads without
 * counting. Over its bucket's `max` within the window means "too many".
 */
export async function recordFailure(bucket: Bucket, id: string): Promise<number> {
  const redis = getRedisClient();
  const k = keyFor(bucket, id);
  const { windowMs } = limits[bucket];
  if (redis) {
    try {
      return Number(await redis.eval(
        "local c = redis.call('INCR', KEYS[1]); if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]); end; return c",
        1, k, String(windowMs),
      ));
    } catch {
      console.warn("[rateLimit] Redis failure count failed");
    }
  }
  checkRateLimitMemory(bucket, id);
  return memoryStore.get(k)?.count ?? 0;
}

export async function failureCount(bucket: Bucket, id: string): Promise<number> {
  const redis = getRedisClient();
  const k = keyFor(bucket, id);
  if (redis) {
    try {
      return Number(await redis.get(k) ?? 0);
    } catch {
      console.warn("[rateLimit] Redis failure read failed");
    }
  }
  const entry = memoryStore.get(k);
  return entry && Date.now() < entry.resetAt ? entry.count : 0;
}

export function isOverLimit(bucket: Bucket, count: number) {
  return count >= limits[bucket].max;
}
