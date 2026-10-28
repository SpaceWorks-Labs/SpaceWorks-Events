import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findReservedSlugConflicts, reservedSlugReport } from "../../scripts/check-reserved-slugs.mjs";

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(root, ...parts), "utf8");

/** A stand-in for PrismaClient.$queryRaw that records the SQL and returns canned rows per call. */
function fakePrisma(responses: unknown[][]) {
  const queries: string[] = [];
  return {
    queries,
    $queryRaw(strings: TemplateStringsArray) {
      queries.push(strings.join("?"));
      return Promise.resolve(responses[queries.length - 1] ?? []);
    },
  };
}

describe("reserved slug deploy preflight (scripts/check-reserved-slugs.mjs)", () => {
  it("matches the release's new addresses case-insensitively", async () => {
    const prisma = fakePrisma([[{ present: true }], [
      { slug: "Attend" }, { slug: "CREW" }, { slug: "help" }, { slug: "Submit" }, { slug: "team" }, { slug: "teamwork" },
    ]]);
    expect(await findReservedSlugConflicts(prisma)).toEqual(["Attend", "CREW", "help", "Submit", "team"]);
    expect(prisma.queries[1]).toContain("lower(slug) = ANY(");
    expect(prisma.queries[1]).toMatch(/^SELECT slug FROM "Organisation"/);
  });

  it("passes on a database without organisations yet", async () => {
    const prisma = fakePrisma([[{ present: false }]]);
    expect(await findReservedSlugConflicts(prisma)).toEqual([]);
    expect(prisma.queries).toHaveLength(1);
  });

  it("explains the remedy and that nothing was migrated", () => {
    expect(reservedSlugReport([])).toBeNull();
    const report = reservedSlugReport(["Help"]);
    expect(report).toContain("/Help");
    expect(report).toContain('UPDATE "Organisation" SET slug');
    expect(report).toContain("Nothing has been migrated");
  });

  it("runs before migrations on the VPS updater and the Helm migration job", () => {
    const updater = read("scripts", "update-vps.sh");
    const check = updater.indexOf("node scripts/check-reserved-slugs.mjs");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(updater.indexOf("compose run --rm migrator"));
    const job = read("charts", "spaceworks-events", "templates", "migration-job.yaml");
    const commands = job.match(/command: \[.*\]/g) ?? [];
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.indexOf("node scripts/check-reserved-slugs.mjs")).toBeGreaterThan(-1);
      expect(command.indexOf("node scripts/check-reserved-slugs.mjs")).toBeLessThan(command.indexOf("docker-entrypoint.sh migrate"));
    }
  });
});
