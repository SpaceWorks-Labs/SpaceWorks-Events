import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import * as dto from "@/lib/mobile/schemas";
import { fixtures, parity } from "./mobile-api-contract/catalog";

/*
 * Keeps docs/mobile-api.openapi.yaml, docs/mobile-api-fixtures/ and the strict
 * response schemas used by the routes (lib/mobile/schemas/) from drifting.
 */

const root = resolve(import.meta.dirname, "../..");
type Schema = Record<string, unknown>;
const spec = load(readFileSync(join(root, "docs/mobile-api.openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Schema> };
};

function deref(schema: Schema): Schema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = ref.replace("#/components/schemas/", "");
  const target = spec.components.schemas[name];
  if (!target) throw new Error(`Unknown $ref ${ref}`);
  return deref(target);
}

/** Merge `allOf` members into one closed object schema (members extend EventSummary-style bases). */
function flatten(input: Schema): Schema {
  const schema = deref(input);
  if (!Array.isArray(schema.allOf)) return schema;
  const parts = (schema.allOf as Schema[]).map(flatten);
  return {
    type: "object",
    properties: Object.assign({}, ...parts.map((part) => part.properties ?? {})),
    required: parts.flatMap((part) => (part.required as string[] | undefined) ?? []),
    additionalProperties: false,
  };
}

function typeOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** A deliberately small JSON Schema (OpenAPI 3.1) validator covering what the spec uses. */
function validate(value: unknown, input: Schema, path = "$"): string[] {
  const schema = flatten(input);
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as Schema[]).filter((option) => validate(value, option, path).length === 0);
    return matches.length === 1 ? [] : [`${path}: expected exactly one oneOf match, got ${matches.length}`];
  }
  if ("const" in schema && value !== schema.const) return [`${path}: expected const ${JSON.stringify(schema.const)}`];
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) return [`${path}: ${JSON.stringify(value)} not in enum`];
  if (schema.type) {
    const allowed = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const actual = typeOf(value);
    const ok = allowed.includes(actual) || (actual === "integer" && allowed.includes("number"));
    if (!ok) return [`${path}: expected ${allowed.join("|")}, got ${actual}`];
    if (actual === "null") return [];
  }
  const errors: string[] = [];
  if (typeof value === "string" && schema.format === "date-time" && Number.isNaN(Date.parse(value))) errors.push(`${path}: invalid date-time`);
  if (typeof value === "string" && schema.format === "uri" && !/^https?:\/\//.test(value)) errors.push(`${path}: invalid uri`);
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => errors.push(...validate(item, schema.items as Schema, `${path}[${index}]`)));
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in object)) errors.push(`${path}.${key}: required`);
    for (const [key, item] of Object.entries(object)) {
      if (properties[key]) errors.push(...validate(item, properties[key]!, `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
      else if (typeof schema.additionalProperties === "object") errors.push(...validate(item, schema.additionalProperties as Schema, `${path}.${key}`));
    }
  }
  return errors;
}


describe("mobile API contract", () => {
  it("covers every fixture file", () => {
    const files = readdirSync(join(root, "docs/mobile-api-fixtures")).filter((file) => file.endsWith(".json")).sort();
    expect(files).toEqual(fixtures.map(([file]) => file).sort());
  });

  it.each(fixtures)("%s matches the OpenAPI schema and the route's Zod schema", (file, component, zod) => {
    const value = JSON.parse(readFileSync(join(root, "docs/mobile-api-fixtures", file), "utf8"));
    expect(validate(value, { $ref: `#/components/schemas/${component}` })).toEqual([]);
    const parsed = zod.safeParse(value);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
  });

  // The small validator above flattens allOf itself; a standard JSON Schema
  // 2020-12 validator (what codegen and API tools use) must accept the same
  // fixtures, so compositions cannot be unsatisfiable.
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: "openapi", components: spec.components } as Schema);

  it.each(fixtures)("%s passes a standard JSON Schema 2020-12 validator", (file, component) => {
    const value = JSON.parse(readFileSync(join(root, "docs/mobile-api-fixtures", file), "utf8"));
    const check = ajv.compile({ $ref: `openapi#/components/schemas/${component}` });
    expect(check(value) ? [] : check.errors).toEqual([]);
  });

  it("standard validation still rejects unknown properties on composed schemas", () => {
    const value = JSON.parse(readFileSync(join(root, "docs/mobile-api-fixtures/org-event-detail.json"), "utf8"));
    value.data.event.leak = "x";
    expect(ajv.compile({ $ref: "openapi#/components/schemas/OrgEventDetailResponse" })(value)).toBe(false);
  });

  it("every $ref resolves when the spec is read by a standard YAML parser", () => {
    const refs: string[] = [];
    const collect = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === "object") {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") refs.push(value);
          else collect(value);
        }
      }
    };
    collect(spec);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((ref) => {
      let node: unknown = spec;
      for (const part of ref.replace(/^#\//, "").split("/")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
      return node === undefined;
    });
    expect(missing).toEqual([]);
  });

  it("gives every operation a default error response", () => {
    const missing = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ["get", "post", "patch", "put", "delete"].includes(method))
        .filter(([, operation]) => !(operation as { responses?: Record<string, unknown> }).responses?.default)
        .map(([method]) => `${method.toUpperCase()} ${path}`));
    expect(missing).toEqual([]);
  });

  it("the validator itself rejects drift", () => {
    const value = JSON.parse(readFileSync(join(root, "docs/mobile-api-fixtures/guests.json"), "utf8"));
    value.data.guests[0].ticketToken = "leak";
    delete value.data.guests[1].isGuest;
    value.data.guests[1].status = "MAYBE";
    expect(validate(value, { $ref: "#/components/schemas/GuestListResponse" })).toEqual([
      "$.data.guests[0].ticketToken: not allowed",
      "$.data.guests[1].isGuest: required",
      '$.data.guests[1].status: "MAYBE" not in enum',
    ]);
  });

  it("documents exactly the implemented /api/mobile/v1 routes and methods", () => {
    const routeDir = join(root, "app/api/mobile/v1");
    const implemented = new Map<string, string[]>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        // The [...path] catch-all only answers unknown paths with a JSON 404.
        if (statSync(full).isDirectory()) { if (!entry.startsWith("[...")) walk(full); }
        else if (entry === "route.ts") {
          const path = `/api/mobile/v1/${relative(routeDir, dir).split("\\").join("/")}`.replace(/\/$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
          const methods = [...readFileSync(full, "utf8").matchAll(/export const (GET|POST|PATCH|PUT|DELETE)\b/g)].map((match) => match[1]!.toLowerCase()).sort();
          implemented.set(path, methods);
        }
      }
    };
    walk(routeDir);
    const documented = new Map(
      Object.entries(spec.paths)
        .filter(([path]) => path.startsWith("/api/mobile/v1/"))
        .map(([path, item]) => [path, Object.keys(item).filter((key) => ["get", "post", "patch", "put", "delete"].includes(key)).sort()]),
    );
    expect(Object.fromEntries(documented)).toEqual(Object.fromEntries(implemented));
  });


  it("documents every mobile error code", () => {
    const envelope = spec.components.schemas.ErrorEnvelope as { properties: { error: { properties: { code: { enum: string[] } } } } };
    expect([...envelope.properties.error.properties.code.enum].sort()).toEqual([...dto.mobileErrorCodeSchema.options].sort());
  });

  it.each(parity)("OpenAPI %s has the same fields as the Zod schema", (component, zod) => {
    const schema = flatten({ $ref: `#/components/schemas/${component}` });
    expect(Object.keys(schema.properties as object).sort()).toEqual(Object.keys(zod.shape).sort());
  });
});
