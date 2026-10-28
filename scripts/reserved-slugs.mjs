// Top-level routes an organisation slug would shadow (`/<orgSlug>`). The one
// list for lib/slug.ts (new and renamed organisations) and for
// scripts/verify-production-schema.mjs, which fails a deploy when an existing
// organisation already holds a slug that a new release reserves
// (docs/production-operations.md, "Reserved organisation addresses").
// Plain JavaScript so the operator image (scripts/*.mjs only) can load it.
export const reservedOrganisationSlugs = Object.freeze([
  "about",
  "account",
  "api",
  "assets",
  "attend",
  "crew",
  "dashboard",
  "discover",
  "embed",
  "event",
  "features",
  "help",
  "join",
  "login",
  "members",
  "new",
  "org",
  "privacy",
  "public",
  "reset-password",
  "search",
  "series",
  "settings",
  "static",
  "submit",
  "super-admin",
  "super-admin-mfa",
  "team",
  "terms",
  "ticket",
  "verify",
  "verify-email",
]);

/** Existing organisation slugs that a reserved route now shadows, in input order. */
export function reservedSlugConflicts(slugs) {
  const reserved = new Set(reservedOrganisationSlugs);
  return slugs.filter((slug) => reserved.has(String(slug).trim().toLowerCase()));
}

/** A deploy-blocking message for those organisations, or null when there are none. */
export function reservedSlugProblem(slugs) {
  const conflicts = reservedSlugConflicts(slugs);
  if (conflicts.length === 0) return null;
  return `Organisation addresses reserved by this release: ${conflicts.map((slug) => `/${slug}`).join(", ")}. `
    + "Their public pages would be hidden behind built-in routes. Rename each organisation's slug and tell its owner "
    + "before deploying (docs/production-operations.md, \"Reserved organisation addresses\").";
}
