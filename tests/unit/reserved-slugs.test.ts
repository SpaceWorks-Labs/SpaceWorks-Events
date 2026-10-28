import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isReservedOrganisationSlug, RESERVED_ORGANISATION_SLUGS } from "@/lib/slug";
import { reservedOrganisationSlugs, reservedSlugConflicts, reservedSlugProblem } from "../../scripts/reserved-slugs.mjs";

describe("reserved organisation slugs", () => {
  it("are one list for the app and the deploy check", () => {
    expect([...RESERVED_ORGANISATION_SLUGS]).toEqual([...reservedOrganisationSlugs]);
    expect(isReservedOrganisationSlug(" Help ")).toBe(true);
    expect(isReservedOrganisationSlug("helpers")).toBe(false);
  });

  it("cover every top-level route", () => {
    const app = path.join(process.cwd(), "app");
    const hasRoute = (dir: string): boolean => readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory()
      ? hasRoute(path.join(dir, entry.name))
      : /^(page|route)\.tsx?$/.test(entry.name));
    const segments = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("[") && !entry.name.startsWith("_"))
      .flatMap((entry) => entry.name.startsWith("(")
        ? segments(path.join(dir, entry.name))
        : hasRoute(path.join(dir, entry.name)) ? [entry.name] : []);
    // Only names a slug can take (lowercase letters, digits, hyphens; not `.well-known`).
    const routes = segments(app).filter((segment) => /^[a-z0-9-]+$/.test(segment));
    expect(routes).toContain("help");
    expect(routes.filter((segment) => !isReservedOrganisationSlug(segment))).toEqual([]);
  });

  it("names existing organisations a reserved route would shadow", () => {
    expect(reservedSlugConflicts(["riverside", "help", "Discover", "helpdesk"])).toEqual(["help", "Discover"]);
    expect(reservedSlugProblem(["riverside"])).toBeNull();
    const problem = reservedSlugProblem(["help"]);
    expect(problem).toContain("/help");
    expect(problem).toContain("Reserved organisation addresses");
  });

  it("fails db:verify when the database holds one", () => {
    const script = readFileSync(path.join(process.cwd(), "scripts", "verify-production-schema.mjs"), "utf8");
    expect(script).toContain('from "./reserved-slugs.mjs"');
    expect(script).toMatch(/reservedSlugProblem\([^)]*\)[\s\S]*throw new Error\(slugProblem\)/);
  });
});
