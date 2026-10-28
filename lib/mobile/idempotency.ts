import "server-only";

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { deriveSecretKey } from "@/lib/instanceConfigSecrets";
import { mobileError, readJsonBody } from "@/lib/mobile/http";

/*
 * Idempotency for mobile writes that venue Wi-Fi tends to retry (the Mentor
 * Desk). Each write must send `Idempotency-Key` (8 to 128 printable
 * characters, one per user action). The first request with a key runs and its
 * answer is kept for a day by user, route and key; a retry with the same key,
 * path and body gets that answer again (`Idempotent-Replayed: true`) without
 * acting twice. The same key on another path (another event, request, slot or
 * round) or with another body is CONFLICT, never another resource's answer.
 *
 * Only definitive answers are kept. Transient and sign-in refusals (5xx, 429,
 * 401, the staff authenticator checks) are not: retry them with the same key.
 * Use a new key only after a definitive 4xx answer, which the same key would
 * replay. A first request still running is CONFLICT; one that started more
 * than STALE_AFTER_MS ago and never finished (the process died mid-write) is
 * IDEMPOTENCY_STALE: its outcome is unknown, so it is never run again under
 * that key. Re-read the record and, if the change is not there, send a new key.
 *
 * Keys and bodies are stored only as HMACs under a key derived from
 * MFA_ENCRYPTION_KEY for this purpose alone, and the kept answers are the
 * routes' small DTOs (ids and versions, never help text).
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
export const STALE_AFTER_MS = 60_000;
const KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;
const IN_PROGRESS = 0;

/** Refusals a retry may change: never kept, so the same key runs again. */
const TRANSIENT_CODES = new Set([
  "RATE_LIMITED", "TOO_MANY_ATTEMPTS", "UNAUTHENTICATED", "MFA_REQUIRED", "REAUTH_REQUIRED", "EMAIL_CODE_REQUIRED",
  "EMAIL_VERIFICATION_REQUIRED", "STAFF_MFA_REQUIRED", "STAFF_MFA_ENROLMENT_REQUIRED", "INTERNAL_ERROR", "PAYMENT_UNAVAILABLE",
]);

const digest = (value: string) => crypto.createHmac("sha256", deriveSecretKey("spaceworks-events-mobile-idempotency-v1")).update(value).digest("hex");

function replay(row: { status: number; body: Prisma.JsonValue | null; }) {
  return NextResponse.json(row.body, { status: row.status, headers: { "Cache-Control": "no-store", "Idempotent-Replayed": "true" } });
}

function isTransient(status: number, kept: unknown) {
  if (status >= 500 || status === 401 || status === 429) return true;
  const code = (kept as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/**
 * Run `write` at most once per Idempotency-Key. `write` gets the parsed JSON
 * body; transient answers (see above) are not kept, so a retry runs again.
 */
export async function idempotentWrite(
  request: Request,
  userId: string,
  routeId: string,
  write: (body: unknown) => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!KEY_PATTERN.test(key)) return mobileError("INVALID_REQUEST", "Send an Idempotency-Key header (8 to 128 characters) with this request.");
  const body = await readJsonBody(request);
  if ("response" in body) return body.response;
  const url = new URL(request.url);
  const keyHash = digest(`key\n${routeId}\n${key}`);
  const requestHash = digest(`request\n${request.method}\n${url.pathname}${url.search}\n${JSON.stringify(body.value ?? null)}`);
  const where = { userId_route_keyHash: { userId, route: routeId, keyHash } };
  const forget = () => prisma.mobileIdempotencyKey.deleteMany({ where: { userId, route: routeId, keyHash } }).catch(() => undefined);
  const now = new Date();

  // Expired keys are free again.
  await prisma.mobileIdempotencyKey.deleteMany({ where: { userId, route: routeId, keyHash, expiresAt: { lte: now } } });
  try {
    await prisma.mobileIdempotencyKey.create({ data: { userId, route: routeId, keyHash, requestHash, status: IN_PROGRESS, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.mobileIdempotencyKey.findUnique({ where });
    if (!existing) return mobileError("CONFLICT", "Retry with a new Idempotency-Key.");
    if (existing.requestHash !== requestHash) return mobileError("CONFLICT", "This Idempotency-Key was used for a different request.");
    if (existing.status !== IN_PROGRESS) return replay(existing);
    if (now.getTime() - existing.createdAt.getTime() > STALE_AFTER_MS) return mobileError("IDEMPOTENCY_STALE");
    return mobileError("CONFLICT", "The first request with this Idempotency-Key is still running. Try again shortly.");
  }

  let response: Response;
  try {
    response = await write(body.value);
  } catch (error) {
    await forget();
    throw error;
  }
  const kept = await response.clone().json().catch(() => null) as Prisma.InputJsonValue | null;
  if (isTransient(response.status, kept)) {
    await forget();
    return response;
  }
  try {
    await prisma.mobileIdempotencyKey.update({ where, data: { status: response.status, body: kept ?? Prisma.DbNull } });
  } catch {
    // The write happened; keep the row in progress (it turns stale) rather than let the key run it twice.
    console.error(`[mobile-api] ${routeId} could not keep its idempotent answer`);
  }
  return response;
}
