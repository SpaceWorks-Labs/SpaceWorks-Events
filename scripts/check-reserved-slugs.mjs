// Deploy preflight: fails before any migration runs when an existing
// organisation holds a slug that this release reserves for a built-in route
// (scripts/reserved-slugs.mjs). Read-only: one SELECT on "Organisation".
//
// Run it with the application's environment before migrating:
//   node scripts/check-reserved-slugs.mjs
// The VPS updater and the Helm migration job run it; on Render run it (or the
// SQL in docs/production-operations.md, "Reserved organisation addresses")
// before deploying. `npm run db:verify` repeats the check after migrating.
// It prints organisation slugs only (public addresses), never connection details.
import { pathToFileURL } from "node:url";
import { reservedOrganisationSlugs, reservedSlugConflicts, reservedSlugProblem } from "./reserved-slugs.mjs";

/** Existing organisation slugs a reserved route would shadow; [] on a database with no organisations yet. */
export async function findReservedSlugConflicts(prisma) {
  const [{ present }] = await prisma.$queryRaw`SELECT to_regclass('public."Organisation"') IS NOT NULL AS present`;
  if (!present) return [];
  const rows = await prisma.$queryRaw`SELECT slug FROM "Organisation" WHERE lower(slug) = ANY(${[...reservedOrganisationSlugs]}::text[]) ORDER BY slug`;
  return reservedSlugConflicts(rows.map((row) => row.slug));
}

/** The operator message with the remedy, or null when the release can deploy. */
export function reservedSlugReport(conflicts) {
  const problem = reservedSlugProblem(conflicts);
  if (!problem) return null;
  return `${problem}\nFor each one, in a transaction: UPDATE "Organisation" SET slug = '<new-slug>' WHERE slug = '<reserved-slug>'; `
    + "then run this check again. Nothing has been migrated.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();
  try {
    const report = reservedSlugReport(await findReservedSlugConflicts(prisma));
    if (report) {
      console.error(report);
      process.exitCode = 1;
    } else {
      console.log("Reserved organisation address check passed.");
    }
  } catch {
    console.error("Reserved organisation address check failed: could not read organisations. Check the database connection; no connection details were logged.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
