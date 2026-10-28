import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { assertDisposableDatabase } from "./guard";

/*
 * Captures the in-app guide's screenshots (public/help/*.png) from a seeded
 * local instance. The seed deletes and recreates its demo data, so point
 * HELP_SCREENS_DATABASE_URL at a disposable, migrated database, never at a
 * database you care about. See content/help/README.md.
 */

const databaseUrl = process.env.HELP_SCREENS_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("Set HELP_SCREENS_DATABASE_URL to a disposable, migrated PostgreSQL database.");
}
// The seed writes through Prisma, which reads DATABASE_URL.
process.env.DATABASE_URL = databaseUrl;
// Fail before starting a server; the seed checks again before writing.
assertDisposableDatabase();

// Fixed dummy keys, used only for this disposable database: the seed encrypts
// with the app's own helpers, and the dev server must decrypt with the same key.
const MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.MFA_ENCRYPTION_KEY = MFA_ENCRYPTION_KEY;

const port = Number(process.env.HELP_SCREENS_PORT || 3124);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./capture",
  testMatch: /.*\.spec\.ts$/,
  globalSetup: "./capture/globalSetup.ts",
  globalTeardown: "./capture/globalTeardown.ts",
  outputDir: "../../test-results/help-screenshots",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 15 * 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    actionTimeout: 60_000,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-GB",
    timezoneId: "Europe/London",
  },
  webServer: {
    // No `PORT=` prefix: it does not work in Windows shells.
    command: `npx next dev -p ${port} --hostname 127.0.0.1`,
    cwd: path.resolve(__dirname, "../.."),
    url: `${baseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 300_000,
    env: {
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      AUTH_SECRET: "help-screens-dummy-auth-secret-not-for-real-use",
      AUTH_URL: baseURL,
      NEXT_PUBLIC_BASE_URL: baseURL,
      MFA_ENCRYPTION_KEY,
      SUPER_ADMIN_EMAIL: "root@example.org",
      // Demo staff sign in without an authenticator, a device code or the breach API.
      STAFF_MFA_REQUIRED: "false",
      LOGIN_NEW_DEVICE_CHECK: "false",
      PWNED_PASSWORDS_CHECK: "false",
      // Each browser context sends its own client address (per-IP rate limits).
      TRUSTED_PROXY_IP_HEADER: "cf-connecting-ip",
      // Serve requests only: no worker or beat, so no email, webhook, chat or payment job ever runs.
      SWE_PROCESS_ROLE: "web",
      // Never deliver mail from a capture run: no SMTP from the environment.
      SMTP_SERVICE: "",
      SMTP_HOST: "",
      SMTP_USER: "",
      SMTP_PASSWORD: "",
      // Local, in-process state and database storage only.
      REDIS_URL: "",
      S3_BUCKET: "",
      S3_ENDPOINT: "",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "",
      // Placeholder Google client, so no real deployment value reaches a screenshot.
      AUTH_GOOGLE_ID: "000000000000-example.apps.googleusercontent.com",
      AUTH_GOOGLE_SECRET: "example-client-secret",
    },
  },
});
