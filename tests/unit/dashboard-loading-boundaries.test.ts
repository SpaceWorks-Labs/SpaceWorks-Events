import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A `loading.tsx` is a Suspense boundary around its segment's page and every
 * segment below it (not its own layout). Once the fallback streams, the HTTP
 * status is a fixed 200, so a notFound()/redirect() inside the boundary becomes
 * a streamed not-found page or a client-side redirect instead of a real
 * 404/307. Every loading screen therefore sits below a layout that already ran
 * the wrapped pages' access check (lib/views/dashboardGuards.ts).
 *
 * This pins every loading.tsx in app/, the guard its layout awaits, and the
 * exact pages it wraps. Adding a loading.tsx, or a page or layout under one,
 * fails here until the new boundary's access checks have been moved above it.
 */

const root = resolve(import.meta.dirname, "../..");
const appDir = resolve(root, "app");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

type Boundary = {
  /** The layout that runs the wrapped pages' check, outside this boundary. */
  guardLayout: string;
  guard: RegExp;
  /** Files rendered inside the boundary, relative to its directory. */
  wraps: string[];
};

const D = "app/dashboard/[orgSlug]";
const page = ["page.tsx"];
const boundaries: Record<string, Boundary> = {
  "app/dashboard/(home)": { guardLayout: "app/dashboard/(home)/layout.tsx", guard: /await guardDashboardHome\(\)/, wraps: page },
  [`${D}/(overview)`]: { guardLayout: `${D}/layout.tsx`, guard: /await loadOrgSlugShell\(\{ params \}\)/, wraps: page },
  [`${D}/members`]: { guardLayout: `${D}/members/layout.tsx`, guard: /await guardOrgMember\(orgSlug\)/, wraps: page },
  [`${D}/series/[seriesId]`]: { guardLayout: `${D}/series/[seriesId]/layout.tsx`, guard: /await guardSeriesDashboard\(orgSlug, seriesId\)/, wraps: page },
  [`${D}/settings/(general)`]: { guardLayout: `${D}/settings/layout.tsx`, guard: /await guardOrgAdmin\(orgSlug\)/, wraps: page },
  [`${D}/settings/api`]: { guardLayout: `${D}/settings/api/layout.tsx`, guard: /await guardOrgOwner\(orgSlug\)/, wraps: page },
  [`${D}/settings/chat`]: { guardLayout: `${D}/settings/layout.tsx`, guard: /await guardOrgAdmin\(orgSlug\)/, wraps: page },
  [`${D}/settings/email`]: { guardLayout: `${D}/settings/email/layout.tsx`, guard: /await guardOrgOwner\(orgSlug\)/, wraps: page },
  [`${D}/settings/payments`]: { guardLayout: `${D}/settings/payments/layout.tsx`, guard: /await guardOrgOwner\(orgSlug\)/, wraps: page },
  [`${D}/settings/webhooks/(list)`]: { guardLayout: `${D}/settings/layout.tsx`, guard: /await guardOrgAdmin\(orgSlug\)/, wraps: page },
  [`${D}/settings/webhooks/[endpointId]`]: { guardLayout: `${D}/settings/webhooks/[endpointId]/layout.tsx`, guard: /await guardWebhookEndpoint\(orgSlug, endpointId\)/, wraps: page },
  [`${D}/ids/(list)`]: { guardLayout: `${D}/ids/layout.tsx`, guard: /await guardOrgMember\(orgSlug\)/, wraps: page },
  [`${D}/ids/[programmeId]`]: { guardLayout: `${D}/ids/[programmeId]/layout.tsx`, guard: /await guardIdProgramme\(orgSlug, programmeId\)/, wraps: page },
  [`${D}/ticket-designs/(list)`]: { guardLayout: `${D}/ticket-designs/(list)/layout.tsx`, guard: /await guardOrgAdmin\(orgSlug\)/, wraps: page },
  [`${D}/ticket-designs/[designId]`]: { guardLayout: `${D}/ticket-designs/[designId]/layout.tsx`, guard: /await guardTicketDesign\(orgSlug, designId\)/, wraps: page },
  [`${D}/event/[eventId]/(overview)`]: { guardLayout: `${D}/event/[eventId]/layout.tsx`, guard: /await guardEventDashboard\(orgSlug, eventId\)/, wraps: page },
  // Badges carry ticket QR codes: exactly the desk's CHECK_IN rule (lib/badge/access.ts).
  [`${D}/event/[eventId]/check-in`]: { guardLayout: `${D}/event/[eventId]/check-in/layout.tsx`, guard: /await guardEventCheckIn\(orgSlug, eventId\)/, wraps: ["badges/page.tsx", "page.tsx"] },
  [`${D}/event/[eventId]/schedule`]: { guardLayout: `${D}/event/[eventId]/schedule/layout.tsx`, guard: /await guardEventSchedule\(orgSlug, eventId\)/, wraps: page },
};

/** Files a Suspense boundary at `dir` renders: its page and everything in nested segments. */
const renderedFile = /^(page|layout|template|default|not-found|forbidden|unauthorized|error)\.(tsx|ts|jsx|js)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const posix = (path: string) => path.split(sep).join("/");
const appFiles = walk(appDir).map((path) => posix(relative(root, path)));

function wrappedFiles(dir: string): string[] {
  return appFiles
    .filter((path) => path.startsWith(`${dir}/`))
    .map((path) => path.slice(dir.length + 1))
    .filter((path) => {
      const name = path.split("/").at(-1) ?? "";
      if (!renderedFile.test(name)) return false;
      // The boundary's own layout/template/error are outside it; its page is inside.
      return path.includes("/") || name.startsWith("page.");
    })
    .sort();
}

describe("dashboard loading boundaries", () => {
  it("allows a loading.tsx only where it is pinned below its access check", () => {
    const loadingDirs = appFiles.filter((path) => /\/loading\.(tsx|ts|jsx|js)$/.test(path)).map((path) => path.slice(0, path.lastIndexOf("/"))).sort();
    expect(loadingDirs).toEqual(Object.keys(boundaries).sort());
  });

  it("has no root or dashboard-wide loading.tsx", () => {
    expect(appFiles).not.toContain("app/loading.tsx");
    expect(appFiles).not.toContain("app/dashboard/loading.tsx");
    expect(appFiles).not.toContain(`${D}/loading.tsx`);
    expect(appFiles).not.toContain(`${D}/event/[eventId]/loading.tsx`);
  });

  it("runs the organisation access check in the organisation layout's view reader", () => {
    expect(source("lib/views/app__dashboard__orgSlug__layout.ts")).toMatch(/await requireOrgDashboardAccess\(orgSlug\)/);
  });

  for (const [dir, boundary] of Object.entries(boundaries)) {
    it(`${dir}/loading.tsx wraps only reviewed pages behind ${boundary.guardLayout}`, () => {
      expect(wrappedFiles(dir)).toEqual([...boundary.wraps].sort());
      // The guard layout is this segment's own layout or an ancestor's, both outside the boundary...
      const guardDir = boundary.guardLayout.slice(0, boundary.guardLayout.lastIndexOf("/"));
      expect(dir === guardDir || dir.startsWith(`${guardDir}/`)).toBe(true);
      expect(source(boundary.guardLayout)).toMatch(boundary.guard);
      // ...and no loading.tsx above that layout wraps it (a segment's own loading.tsx does not).
      for (const other of Object.keys(boundaries)) {
        expect(guardDir.startsWith(`${other}/`)).toBe(false);
      }
    });
  }

  it("streams no page-level Suspense boundary outside the reviewed sign-in form", () => {
    const withSuspense = appFiles.filter((path) => /\.(tsx|jsx)$/.test(path) && /<Suspense\b/.test(source(path)));
    expect(withSuspense).toEqual(["app/(auth)/login/page.tsx"]);
  });
});
