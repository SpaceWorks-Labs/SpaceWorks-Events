/*
 * App-link association files for the Space Works mobile apps (Android and
 * iOS). Everything comes from runtime environment variables, never the build,
 * because one release image serves every installation: without
 * configuration they claim nothing.
 *
 * ANDROID_APP_PACKAGE_NAME            Android application id (default below)
 * ANDROID_APP_SHA256_FINGERPRINTS     signing-certificate SHA-256s, comma separated
 * APPLE_APP_IDS                       "TEAMID.bundle.id", comma separated
 */

export const DEFAULT_ANDROID_PACKAGE_NAME = "in.spaceworks.events";

export function androidPackageName(raw = process.env.ANDROID_APP_PACKAGE_NAME) {
  const value = raw?.trim();
  return value && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(value) ? value : DEFAULT_ANDROID_PACKAGE_NAME;
}

function list(raw: string | undefined) {
  return (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

/** Digital Asset Links statement from `ANDROID_APP_SHA256_FINGERPRINTS`. */
export function assetLinksStatement(rawFingerprints = process.env.ANDROID_APP_SHA256_FINGERPRINTS, packageName = androidPackageName()) {
  const fingerprints = list(rawFingerprints)
    .map((value) => value.toUpperCase())
    .filter((value) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value));
  if (fingerprints.length === 0) return [];
  return [{
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: fingerprints },
  }];
}

/*
 * Apple `components` patterns support only `*` (any characters, including
 * "/") and `?` (one character), evaluated in order with the first match
 * winning. Exclusions therefore come first. Event short codes are left out:
 * `/???????` cannot require the uppercase letter every short code has, so it
 * would also claim 7-character organisation pages. Short links still open the
 * website, which redirects to the event page (claimed below).
 */
export const APP_LINK_EXCLUDED_PATHS = [
  "/api/*",
  "/_next/*",
  "/.well-known/*",
  "/dashboard",
  "/dashboard/*",
  "/account",
  "/account/*",
  "/super-admin",
  "/super-admin/*",
  "/verify-mfa",
  "/verify-mfa/*",
  "/login",
  "/login/*",
  "/reset-password",
  "/reset-password/*",
  "/verify-email",
  "/verify-email/*",
  "/join/*",
  "/embed/*",
  "/help",
  "/help/*",
  "/team/*",
  "/submit/*",
  "/attend/*",
  "/crew/*",
  // Space Works bearer links and pages that stay on the website: buyer
  // orders, member ID verification and the member ID pages.
  "/order/*",
  "/verify/*",
  "/*/ids",
  "/*/ids/*",
  "/*/*/check-in",
  "/*/*/check-in/*",
  "/*/i/*",
  "/*/*/schedule",
  "/*/*/schedule/*",
  "/*/*/sessions/*",
  "/*/*/speakers/*",
  "/*/*/team/*",
  "/*/*/projects",
  "/*/*/projects/*",
  "/*/*/results",
  "/*/*/results/*",
] as const;

/** Claimed after the exclusions: attendee tickets, feedback forms and event pages. */
export const APP_LINK_INCLUDED_PATHS = [
  { path: "/ticket/*", comment: "Attendee tickets" },
  { path: "/*/*/feedback", comment: "Event feedback forms" },
  { path: "/*/*", comment: "Event pages" },
] as const;

/**
 * Apple App Site Association from `APPLE_APP_IDS` ("TEAMID.bundle.id", comma
 * separated); empty details when unset.
 */
export function appleAppSiteAssociation(rawAppIds = process.env.APPLE_APP_IDS) {
  const appIDs = list(rawAppIds).filter((value) => /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(value));
  if (appIDs.length === 0) return { applinks: { details: [] } };
  return {
    applinks: {
      details: [{
        appIDs,
        components: [
          ...APP_LINK_EXCLUDED_PATHS.map((path) => ({ "/": path, exclude: true })),
          ...APP_LINK_INCLUDED_PATHS.map(({ path, comment }) => ({ "/": path, comment })),
        ],
      }],
    },
  };
}
