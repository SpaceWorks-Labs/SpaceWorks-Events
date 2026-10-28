/**
 * The client address header the server under test trusts. CI's hosting runs
 * trust x-real-ip (scripts/test-split-hosting.mjs); a hard-coded
 * cf-connecting-ip is ignored there, so every test shares one rate-limit bucket.
 */
export const ipHeader = process.env.PLAYWRIGHT_TRUSTED_IP_HEADER || "cf-connecting-ip";

/**
 * The site origin. Browsers send it on every POST; the split frontend's API
 * proxy refuses an unsafe request without it, so direct API posts set it too.
 */
export const appOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT || 3000}`;
