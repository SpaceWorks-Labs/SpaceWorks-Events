import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretFields } from "@/lib/frontend/secretFields";

/*
 * Every hashed, encrypted or secret column in the schema is a forbidden
 * field for view readers and mobile DTOs (lib/frontend/secretFields.ts), so
 * a new one can't reach a browser or an app by being selected by accident.
 */

function schemaFieldNames(): string[] {
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
  const names = new Set<string>();
  for (const block of schema.matchAll(/^model \w+ \{([\s\S]*?)^\}/gm)) {
    for (const line of block[1]!.split("\n")) {
      const field = /^\s+([A-Za-z_]\w*)\s+\S/.exec(line)?.[1];
      if (field && !line.trim().startsWith("//")) names.add(field);
    }
  }
  return [...names];
}

describe("secret fields", () => {
  it("covers every schema field named like a hash, an encrypted value or a secret", () => {
    const fields = schemaFieldNames();
    expect(fields).toContain("passwordHash");
    const sensitive = fields.filter((name) => /hash|encrypted|secret/i.test(name));
    expect(sensitive.length).toBeGreaterThan(20);
    expect(sensitive.filter((name) => !secretFields.has(name))).toEqual([]);
  });
});
