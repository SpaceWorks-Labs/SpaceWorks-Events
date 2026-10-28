import { reservedOrganisationSlugs } from "../scripts/reserved-slugs.mjs";

const slugRegex = /[^a-z0-9]+/g;

export function slugifyTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(slugRegex, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "event";
}

export function withSlugSuffix(base: string, suffix: number): string {
  return suffix === 0 ? base : `${base}-${suffix}`;
}

/** Top-level routes an organisation slug would shadow (`/<orgSlug>`); the list lives in scripts/reserved-slugs.mjs so deploy checks share it. */
export const RESERVED_ORGANISATION_SLUGS: ReadonlySet<string> = new Set(reservedOrganisationSlugs);

/** Routes under `/<orgSlug>/` an event slug would shadow (member IDs, series instances). */
export const RESERVED_EVENT_SLUGS: ReadonlySet<string> = new Set(["i", "ids"]);

export function isReservedOrganisationSlug(slug: string) {
  return RESERVED_ORGANISATION_SLUGS.has(slug.trim().toLowerCase());
}

export function isReservedEventSlug(slug: string) {
  return RESERVED_EVENT_SLUGS.has(slug.trim().toLowerCase());
}
