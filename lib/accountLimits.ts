/*
 * Account registrations paging: page sizes and the pure URL helpers. No
 * database access, so the account page can import it in the frontend build.
 */

/** Rows per page in each section (Upcoming, Past, Certificates); nothing here is unbounded. */
export const ACCOUNT_REGISTRATIONS_LIMIT = 50;
export const ACCOUNT_CERTIFICATES_LIMIT = 50;
/** Highest page number accepted from the URL (`?past=3`). */
export const MAX_ACCOUNT_PAGE = 1000;

export const ACCOUNT_SECTIONS = ["upcoming", "past", "certificates"] as const;
export type AccountSectionKey = (typeof ACCOUNT_SECTIONS)[number];
export type AccountPages = Record<AccountSectionKey, number>;
export type AccountSectionPagination = { page: number; totalPages: number; total: number; pageSize: number };

/** A section's page number from the URL; anything malformed is page 1. */
export function accountPageParam(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^\d{1,4}$/.test(raw)) return 1;
  return Math.min(MAX_ACCOUNT_PAGE, Math.max(1, Number(raw)));
}

/** Clamp a requested page to the pages that exist (an empty section still has page 1). */
export function accountSectionPagination(requested: number, total: number, pageSize: number): AccountSectionPagination {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return { page: Math.min(Math.max(1, requested), totalPages), totalPages, total, pageSize };
}

/** Section page links that keep the other sections' pages (page 1 is left out of the URL). */
export function accountSectionHref(pages: AccountPages, section: AccountSectionKey, page: number): string {
  const params = new URLSearchParams();
  for (const key of ACCOUNT_SECTIONS) {
    const value = key === section ? page : pages[key];
    if (value > 1) params.set(key, String(value));
  }
  const query = params.toString();
  return `/account/registrations${query ? `?${query}` : ""}#${section}`;
}
