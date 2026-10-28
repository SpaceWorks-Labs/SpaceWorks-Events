import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ORG_SLUG, PASSWORD } from "../seed/common";
import { seed } from "./state";

/* Browser helpers for the capture steps: contexts, hydration and signing in. */

let ipCounter = 10;

export const dashboard = () => `/dashboard/${ORG_SLUG}`;
export const eventDashboard = (event: keyof ReturnType<typeof seed>["events"], query = "") => `${dashboard()}/event/${seed().events[event].id}${query}`;

/** Each context gets its own client address so per-IP rate limits never couple steps. */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.51.100.${(ipCounter++ % 240) + 10}` });
  // No full reloads from the dev server: edits elsewhere in the tree (and
  // Turbopack's occasional "restart" on a cold start) must not reload a page
  // halfway through a capture. Everything else passes through.
  await context.routeWebSocket(/\/_next\/(webpack-)?hmr/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (typeof message === "string" && /"type":"(reloadPage|restart)"/.test(message)) return;
      socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
  // Keep the Next.js development indicator out of every screenshot.
  await context.addInitScript(() => {
    const hide = () => {
      const style = document.createElement("style");
      style.textContent = "nextjs-portal { display: none !important; }";
      document.head.appendChild(style);
    };
    if (document.head) hide();
    else document.addEventListener("DOMContentLoaded", hide);
  });
  return context;
}

/** Waits until React has hydrated the page, so clicks and typing reach controlled state. */
export async function hydrated(page: Page) {
  await expect
    // A cold dev server may reload the page once while it compiles; keep polling.
    .poll(() => page.evaluate(() => Object.keys(document.body).some((key) => key.startsWith("__reactFiber")) && !document.querySelector("[data-nextjs-dialog]")).catch(() => false), { timeout: 120_000 })
    .toBe(true);
}

export async function open(page: Page, url: string) {
  await page.goto(url, { timeout: 180_000 });
  await hydrated(page);
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}

async function signIn(page: Page, email: string) {
  await page.request.get("/api/auth/csrf");
  for (let attempt = 1; ; attempt++) {
    await open(page, "/login");
    await page.getByRole("textbox", { name: /^Email/ }).fill(email);
    await page.locator('input[type="password"]:visible').fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const failed = page.getByRole("alert").filter({ hasText: /Invalid/ });
    await expect.poll(async () => !new URL(page.url()).pathname.startsWith("/login") || (await failed.count()) > 0, { timeout: 90_000 }).toBe(true);
    if (!new URL(page.url()).pathname.startsWith("/login")) return;
    if (attempt === 3) throw new Error(`Sign-in failed three times for ${email}`);
  }
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const sessions = new Map<string, StorageState>();

/** Signs in once per person and reuses the session (repeated sign-ins trip the auth rate limit). */
export async function userPage(browser: Browser, email: string, options: { fresh?: boolean } = {}) {
  if (!sessions.has(email) || options.fresh) {
    const signInContext = await newContext(browser);
    await signIn(await signInContext.newPage(), email);
    sessions.set(email, await signInContext.storageState());
    await signInContext.close();
  }
  const context = await newContext(browser, { storageState: sessions.get(email) });
  return { context, page: await context.newPage() };
}

export async function anonymousPage(browser: Browser) {
  const context = await newContext(browser);
  return { context, page: await context.newPage() };
}
