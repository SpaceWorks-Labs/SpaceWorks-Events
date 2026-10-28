import "server-only";

import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { mobileError, readJsonBody } from "@/lib/mobile/http";

/*
 * Idempotency for mobile writes that venue Wi-Fi tends to retry (the Mentor
 * Desk). Each write must send `Idempotency-Key` (8 to 128 printable
 * characters, one per user action). The first request with a key runs and its
 * answer is kept for a day by user, route and key; a retry with the same key
 * and body gets that answer again (`Idempotent-Replayed: true`) without acting
 * twice. The same key with another body, or while the first is still running,
 * is CONFLICT. Only SHA-256 digests of the key and body are stored, and the
 * kept answers are the routes' small DTOs (ids and versions, never help text).
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const KEY_PATTERN = /^[\x21-\x7e]{8,128}$/;
const IN_PROGRESS = 0;

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

function replay(row: { status: number; body: Prisma.JsonValue | null; }) {
  return NextResponse.json(row.body, { status: row.status, headers: { "Cache-Control": "no-store", "Idempotent-Replayed": "true" } });
}

/**
 * Run `write` at most once per Idempotency-Key. `write` gets the parsed JSON
 * body; answers of 500 and above are not kept, so a retry runs again.
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
  const keyHash = sha256(`${routeId}\n${key}`);
  const requestHash = sha256(JSON.stringify(body.value ?? null));
  const now = new Date();

  // Expired keys are free again.
  await prisma.mobileIdempotencyKey.deleteMany({ where: { userId, route: routeId, keyHash, expiresAt: { lte: now } } });
  try {
    await prisma.mobileIdempotencyKey.create({ data: { userId, route: routeId, keyHash, requestHash, status: IN_PROGRESS, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) } });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
    const existing = await prisma.mobileIdempotencyKey.findUnique({ where: { userId_route_keyHash: { userId, route: routeId, keyHash } } });
    if (!existing) return mobileError("CONFLICT", "Retry with a new Idempotency-Key.");
    if (existing.requestHash !== requestHash) return mobileError("CONFLICT", "This Idempotency-Key was used for a different request.");
    if (existing.status === IN_PROGRESS) return mobileError("CONFLICT", "The first request with this Idempotency-Key is still running. Try again shortly.");
    return replay(existing);
  }

  let response: Response;
  try {
    response = await write(body.value);
  } catch (error) {
    await prisma.mobileIdempotencyKey.deleteMany({ where: { userId, route: routeId, keyHash } }).catch(() => undefined);
    throw error;
  }
  if (response.status >= 500) {
    await prisma.mobileIdempotencyKey.deleteMany({ where: { userId, route: routeId, keyHash } });
    return response;
  }
  const kept = await response.clone().json().catch(() => null) as Prisma.InputJsonValue | null;
  await prisma.mobileIdempotencyKey.update({
    where: { userId_route_keyHash: { userId, route: routeId, keyHash } },
    data: { status: response.status, body: kept ?? Prisma.DbNull },
  });
  return response;
}
