import { readFileSync } from "node:fs";
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
