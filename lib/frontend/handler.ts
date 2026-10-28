import "server-only";
import { z } from "zod";
import { NextResponse } from "next/server";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { decodeWire, encodeWire } from "./codec";
import { frontendOrigin } from "./config";
import { isFrontendPeer } from "./peer";
import { collectInvalidations } from "./revalidation";
import { backendActions, viewReaders } from "./registry";
import { secretFields } from "./secretFields";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const stringValue = z.string().max(2048);
const params = z.record(z.string().max(128), stringValue).refine((value) => Object.keys(value).length <= 12);
const query = z.record(z.string().max(128), z.union([stringValue, z.array(stringValue).max(20)])).refine((value) => Object.keys(value).length <= 50);
const viewInput = z.array(z.object({
  params: params.optional(), searchParams: query.optional(),
  ctx: z.object({ organisation: z.object({ slug: z.string().min(1).max(128) }).strict(), event: z.object({ id: z.string().min(1).max(128) }).strict() }).strict().optional(),
}).strict()).max(1);

/** Final defence: a view reader must use safe selects/DTOs before crossing hosts. */
export function assertSafeView(value: unknown, depth = 0): void {
  if (depth > 48) throw new Error("View is too deeply nested.");
  if (!value || typeof value !== "object" || value instanceof Date) return;
  if (value instanceof Map) { for (const [key, item] of value) { assertSafeView(key, depth + 1); assertSafeView(item, depth + 1); } return; }
  if (value instanceof Set || Array.isArray(value)) { for (const item of value) assertSafeView(item, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    if (secretFields.has(key)) throw new Error("A view included a forbidden field.");
    assertSafeView(item, depth + 1);
  }
}

function navigation(error: unknown) {
  if (!error || typeof error !== "object" || !("digest" in error) || typeof error.digest !== "string") return null;
  if (error.digest === "NEXT_HTTP_ERROR_FALLBACK;404") return { type: "not-found" as const };
  const parts = error.digest.split(";");
  if (parts[0] === "NEXT_REDIRECT" && ["push", "replace"].includes(parts[1])) {
    const location = parts.slice(2, -2).join(";");
    const url = new URL(location, frontendOrigin());
    if (url.origin === frontendOrigin() && !/[\r\n]/.test(location)) return { type: "redirect" as const, location: url.pathname + url.search + url.hash };
  }
  return null;
}

async function readBody(request: Request, limit: number) {
  if (!request.body) throw new Error("Body required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Body too large."); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

type Endpoint = (...args: never[]) => Promise<unknown>;

export async function frontendRequest(request: Request, kind: string, endpoint: string) {
  if (!isFrontendPeer(request.headers) || request.headers.get("origin") !== frontendOrigin()) return new NextResponse("Not found", { status: 404, headers: PRIVATE_HEADERS });
  if (kind === "guard" && (endpoint === "action" || endpoint === "search")) {
    return new NextResponse(null, { status: await isActionRateLimited(endpoint === "action" ? "frontendAction" : "search") ? 429 : 204, headers: PRIVATE_HEADERS });
  }
  if (kind !== "view" && kind !== "action") return new NextResponse("Not found", { status: 404, headers: PRIVATE_HEADERS });
  const registry = kind === "view" ? viewReaders : backendActions;
  if (endpoint.length > 220 || !Object.hasOwn(registry, endpoint)) return new NextResponse("Not found", { status: 404, headers: PRIVATE_HEADERS });
  if (kind === "action" && await isActionRateLimited("action")) return NextResponse.json({ ok: false }, { status: 429, headers: PRIVATE_HEADERS });
  let args: unknown[];
  try {
    const decoded = decodeWire(await readBody(request, kind === "view" ? 64 * 1024 : 12 * 1024 * 1024));
    if (!Array.isArray(decoded) || decoded.length > 4) throw new Error();
    args = kind === "view" ? viewInput.parse(decoded) : decoded;
  } catch { return NextResponse.json({ ok: false }, { status: 400, headers: PRIVATE_HEADERS }); }
  try {
    const fn = (registry as Record<string, Endpoint>)[endpoint];
    const { result, invalidations } = await collectInvalidations(async () => {
      try {
        const value = await fn(...args as never[]);
        if (kind === "view") assertSafeView(value);
        return { ok: true, value: await encodeWire(value) };
      } catch (error) {
        const target = navigation(error);
        if (target) return { ok: true, navigation: target };
        throw error;
      }
    });
    return NextResponse.json({ ...result, invalidations }, { headers: PRIVATE_HEADERS });
  } catch {
    console.error("[frontend-peer] Request failed");
    return NextResponse.json({ ok: false }, { status: 500, headers: PRIVATE_HEADERS });
  }
}
