// Shared state, setup and helpers for tests/e2e/teams.spec.ts. Its tests run
// in order against one organisation and its events created here.
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus, MembershipRole, PrismaClient } from "@prisma/client";
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ipHeader } from "./client";

export const prisma = new PrismaClient();
export const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
export const ownerEmail = `teams-owner-${suffix}@example.test`;
const password = "teams-journey-password";
export const orgSlug = `teams-${suffix}`;
export const eventSlug = `hack-${suffix}`;
export const eventTitle = `Team Hack ${suffix}`;
export const approvalSlug = `jam-${suffix}`;
export const approvalTitle = `Approval Jam ${suffix}`;
export const teamName = `Night Owls ${suffix}`;
export const approvalTeamName = `Early Birds ${suffix}`;
export const leader = { name: "Lena Leader", email: `teams-leader-${suffix}@example.test` };
export const member = { name: "Milo Member", email: `teams-member-${suffix}@example.test` };
export const approvalLeader = { name: "Aria Approval", email: `teams-approval-leader-${suffix}@example.test` };
export const approvalMember = { name: "Bram Approval", email: `teams-approval-member-${suffix}@example.test` };
export const soloEntrant = { name: "Sol Solo", email: `teams-solo-${suffix}@example.test` };
export const matchSlug = `match-${suffix}`;
export const matchTitle = `Match Night ${suffix}`;
export const matchLeader = { name: "Max Match", email: `teams-match-leader-${suffix}@example.test` };
export const matchSeeker = { name: "Sasha Seeker", email: `teams-match-seeker-${suffix}@example.test` };
export const declinedLeader = { name: "Dana Declined", email: `teams-declined-leader-${suffix}@example.test` };
const testEmails = [
  ownerEmail,
  leader.email,
  member.email,
  approvalLeader.email,
  approvalMember.email,
  soloEntrant.email,
  matchLeader.email,
  matchSeeker.email,
  declinedLeader.email,
];

let ownerId = "";
export let organisationId = "";
export let eventId = "";
let ipCounter = 10;

/** Each context gets its own client address so per-IP rate limits never couple steps. */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.setExtraHTTPHeaders({ [ipHeader]: `198.51.100.${ipCounter++}` });
  return context;
}

async function signIn(page: Page) {
  // A cold dev server compiles the auth routes on first use, which can fail
  // the first credentials round trip; warm them and allow a couple of retries.
  await page.request.get("/api/auth/csrf");
  await page.request.get("/api/auth/session");
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login");
    // Typing before hydration leaves the controlled inputs' state empty.
    const emailInput = page.getByRole("textbox", { name: /^Email/ });
    await expect.poll(() => emailInput.evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
    await emailInput.fill(ownerEmail);
    await page.locator('input[type="password"]:visible').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const failed = page.getByRole("alert").filter({ hasText: "Invalid email or password" });
    await expect.poll(async () => !new URL(page.url()).pathname.startsWith("/login") || (await failed.count()) > 0, { timeout: 60_000 }).toBe(true);
    if (!new URL(page.url()).pathname.startsWith("/login")) return;
    if (attempt === 3) throw new Error("Owner sign-in failed three times");
  }
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
let ownerSession: StorageState | undefined;

/** Signs in once and reuses the session: repeated sign-ins would trip the per-minute auth limit. */
export async function ownerContext(browser: Browser) {
  if (!ownerSession) {
    const signInContext = await newContext(browser);
    await signIn(await signInContext.newPage());
    ownerSession = await signInContext.storageState();
    await signInContext.close();
  }
  const context = await newContext(browser, { storageState: ownerSession });
  const page = await context.newPage();
  return { context, page };
}

/** Uncaught client errors fail the step that caused them. */
export function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

/** Waits for React to hydrate a control, so typing reaches controlled state. */
export async function waitForHydration(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).first().evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
}

/** Registrations queue real emails; drop them before any worker pass can send to test addresses. */
export async function discardQueuedTestEmail() {
  const messages = await prisma.outboxMessage.findMany({ select: { id: true, payload: true } });
  const ids = messages
    .filter((message) => {
      const to = (message.payload as { to?: unknown } | null)?.to;
      return typeof to === "string" && testEmails.includes(to);
    })
    .map((message) => message.id);
  if (ids.length) await prisma.outboxMessage.deleteMany({ where: { id: { in: ids } } });
}

/** The capability pages are private bearer links: no Referer, no index, no shared cache. */
export async function expectCapabilityHeaders(response: APIResponse, label: string) {
  expect(response.status(), label).toBe(200);
  const headers = response.headers();
  expect(headers["referrer-policy"], label).toBe("no-referrer");
  // The production server (CI's `test:e2e:production`) sends the proxy's
  // capability-page value `private, no-cache, no-store, ...`; `next dev`
  // always sends its own `no-cache, must-revalidate`, so only require a
  // non-shareable value there.
  const cacheControl = headers["cache-control"] ?? "";
  if (process.env.PLAYWRIGHT_PRODUCTION_SERVER === "1") expect(cacheControl, label).toContain("no-store");
  else expect(cacheControl, label).toMatch(/no-store|no-cache/);
  expect(cacheControl, label).not.toMatch(/public|s-maxage/);
  const body = await response.text();
  expect(body, label).toMatch(/<meta name="robots" content="noindex, nofollow"\s*\/?>/);
  expect(body, label).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
}

export async function createTeamEvent(data: { slug: string; title: string; privacyType: EventPrivacyType }) {
  const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return prisma.event.create({
    data: {
      organisationId,
      title: data.title,
      slug: data.slug,
      startDateTime: start,
      endDateTime: new Date(start.getTime() + 8 * 60 * 60 * 1000),
      timezone: "UTC",
      location: "Makerspace, 2 Test Street",
      status: EventStatus.PUBLISHED,
      privacyType: data.privacyType,
      page: { create: { isPublished: true, aboutHtml: "<p>Build something in a day.</p>" } },
    },
  });
}

/** Creates the organisation, its owner and the public TEAM event before the suite, and removes them after. */
export function setUpTeamsSuite() {
  test.beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { email: ownerEmail, name: "Teams Owner", passwordHash: await bcrypt.hash(password, 12), emailVerified: new Date() },
    });
    ownerId = owner.id;
    const organisation = await prisma.organisation.create({
      data: { name: `Teams ${suffix}`, slug: orgSlug, memberships: { create: { userId: ownerId, role: MembershipRole.OWNER } } },
    });
    organisationId = organisation.id;
    eventId = (await createTeamEvent({ slug: eventSlug, title: eventTitle, privacyType: EventPrivacyType.PUBLIC })).id;
  });

  test.afterAll(async () => {
    await discardQueuedTestEmail();
    if (organisationId) await prisma.organisation.deleteMany({ where: { id: organisationId } });
    if (ownerId) await prisma.user.deleteMany({ where: { id: ownerId } });
    await prisma.$disconnect();
  });
}
