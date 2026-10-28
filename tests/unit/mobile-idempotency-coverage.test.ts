import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/*
 * Every signed-in mobile write runs at most once per Idempotency-Key
 * (lib/mobile/idempotency.ts), and docs/mobile-api.openapi.yaml marks the
 * header required on it. The exemptions below are the whole list, each with
 * its reason (docs/MOBILE_API.md "Idempotency").
 */

const root = resolve(import.meta.dirname, "../..");
const routeDir = join(root, "app/api/mobile/v1");
const O = "/api/mobile/v1/orgs/{orgSlug}/events/{eventId}";

const EXEMPT: Record<string, string> = {
  "POST /api/mobile/v1/auth/google": "signs in: the answer is a new session's tokens, which are never stored",
  "POST /api/mobile/v1/auth/login": "signs in: the answer is a new session's tokens, which are never stored",
  "POST /api/mobile/v1/auth/refresh": "rotates the session's tokens: a refresh token works once",
  "POST /api/mobile/v1/auth/mfa": "a code is checked once; the answer is a session",
  "POST /api/mobile/v1/auth/logout": "ends the session: a repeat has nothing left to end",
  "POST /api/mobile/v1/auth/logout-all": "ends every session: a repeat has nothing left to end",
  [`POST ${O}/broadcasts/count`]: "reads only",
  [`POST ${O}/broadcasts/preview`]: "reads only",
  [`POST ${O}/check-in/preview`]: "reads only",
  "POST /api/mobile/v1/public/access-code/unlock": "reads only, without an account",
  "POST /api/mobile/v1/public/promo/check": "reads only, without an account",
  [`POST ${O}/guests/{rsvpId}/attendance-link`]: "the answer is a fresh bearer link, never stored; each call replaces the last",
  "PATCH /api/mobile/v1/me": "sets values: a repeat changes nothing",
  "PATCH /api/mobile/v1/me/orders/{orderId}/tickets/{rsvpId}": "sets values: a repeat changes nothing",
  [`DELETE ${O}/crew/{memberId}`]: "a repeat finds nothing to remove",
  [`DELETE ${O}/guests/{rsvpId}`]: "a repeat finds nothing to remove",
  [`POST ${O}/judging/submissions/{submissionId}/recusal`]: "sets the judge's recusal: a repeat changes nothing",
  [`DELETE ${O}/judging/submissions/{submissionId}/recusal`]: "clears the judge's recusal: a repeat changes nothing",
};
/** Signed in only: the guest flow has no account to hold keys (its duplicate check by email applies). */
const SIGNED_IN_ONLY = new Set(["POST /api/mobile/v1/rsvp"]);

type Operation = { parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }> };
const spec = load(readFileSync(join(root, "docs/mobile-api.openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { parameters: Record<string, { name: string; in: string; required?: boolean }> };
};

function keyParameter(operation: Operation | undefined) {
  for (const parameter of operation?.parameters ?? []) {
    const resolved = parameter.$ref ? spec.components.parameters[parameter.$ref.replace("#/components/parameters/", "")] : parameter;
    if (resolved?.in === "header" && resolved.name === "Idempotency-Key") return resolved;
  }
  return null;
}

const writes: Array<{ id: string; idempotent: boolean; operation: Operation | undefined }> = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { if (!entry.startsWith("[...")) walk(full); continue; }
    if (entry !== "route.ts") continue;
    const source = readFileSync(full, "utf8");
    const path = `/api/mobile/v1/${relative(routeDir, dir).split("\\").join("/")}`.replace(/\/$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
    for (const [, method] of source.matchAll(/export const (POST|PATCH|PUT|DELETE)\b/g)) {
      writes.push({
        id: `${method} ${path}`,
        idempotent: /\bidempotent: |\bidempotentWrite\(|\bidempotentRequest\(|\bdeskWrite\(/.test(source),
        operation: spec.paths[path]?.[method!.toLowerCase()],
      });
    }
  }
};
walk(routeDir);

describe("mobile idempotency coverage", () => {
  it("finds the mobile writes", () => {
    expect(writes.length).toBeGreaterThan(60);
  });

  it("runs every write that is not exempt at most once per key, and documents the header as required", () => {
    const missing = writes.filter((write) => !EXEMPT[write.id]).flatMap((write) => {
      const header = keyParameter(write.operation);
      const problems: string[] = [];
      if (!write.idempotent) problems.push(`${write.id}: route without idempotency`);
      if (!header) problems.push(`${write.id}: OpenAPI has no Idempotency-Key header`);
      else if (header.required !== !SIGNED_IN_ONLY.has(write.id)) problems.push(`${write.id}: Idempotency-Key required should be ${!SIGNED_IN_ONLY.has(write.id)}`);
      return problems;
    });
    expect(missing).toEqual([]);
  });

  it("keeps the exemptions to real routes that take no key", () => {
    const ids = new Set(writes.map((write) => write.id));
    expect(Object.keys(EXEMPT).filter((id) => !ids.has(id))).toEqual([]);
    expect(writes.filter((write) => EXEMPT[write.id] && (write.idempotent || keyParameter(write.operation))).map((write) => write.id)).toEqual([]);
  });
});
