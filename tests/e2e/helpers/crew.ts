import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus, MembershipRole, PrismaClient } from "@prisma/client";
import { expect, test, type APIResponse, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { appOrigin, ipHeader } from "./client";

// Shared setup for the event crew journeys (docs/CREW.md, tests/e2e/crew.spec.ts):
// an owner, an organisation and a capacity-1 event with a crew sign-up link.

export const prisma = new PrismaClient();
export const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
export const ownerEmail = `crew-owner-${suffix}@example.test`;
export const password = "crew-journey-password";
export const orgSlug = `crew-${suffix}`;
export const eventSlug = `meetup-${suffix}`;
export const eventTitle = `Crew Meetup ${suffix}`;
// Generated like generateCrewJoinToken (lib/core/crew.ts): 32 random bytes, base64url.
export const crewToken = randomBytes(32).toString("base64url");
export const crewPath = `/crew/${crewToken}`;
export const crewMember = {
  name: "Casey Crew",
  email: `crew-member-${suffix}@example.test`,
  food: `Vegan ${suffix}`,
  role: `Registration desk ${suffix}`,
};
export const attendee = { name: "Avery Attendee", email: `crew-attendee-${suffix}@example.test` };
export const lateAttendee = { name: "Liam Late", email: `crew-late-${suffix}@example.test` };
export const testEmails = [ownerEmail, crewMember.email, attendee.email, lateAttendee.email];

/** Set by setUpCrewSuite before the first test. */
export const ids = { ownerId: "", organisationId: "", eventId: "", eventPageId: "" };
let ipCounter = 10;

/** Each context gets its own client address so per-IP rate limits never couple steps. */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.setExtraHTTPHeaders({ [ipHeader]: `198.51.100.${ipCounter++}` });
  return context;
}

export async function signIn(page: Page) {
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

/** Crew and attendee tickets queue real emails; drop them before any worker pass can send to test addresses. */
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

/** The crew link is a private bearer link: no Referer, no index, no shared cache. */
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
  return body;
}

/** Registers an attendee through the endpoint the public form posts to, from its own client address. */
export async function registerAttendee(browser: Browser, person: { name: string; email: string }) {
  const context = await newContext(browser);
  const response = await context.request.post("/api/rsvp", {
    headers: { origin: appOrigin },
    data: { orgSlug, eventSlug, guestEmail: person.email, name: person.name, answers: {} },
  });
  const result = { status: response.status(), text: await response.text() };
  await context.close();
  return result;
}


/** Registers the suite's owner, organisation and capacity-1 event (with its crew link) and removes them afterwards. */
export function setUpCrewSuite() {
  test.beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { email: ownerEmail, name: "Crew Owner", passwordHash: await bcrypt.hash(password, 12), emailVerified: new Date() },
    });
    ids.ownerId = owner.id;
    const organisation = await prisma.organisation.create({
      data: { name: `Crew ${suffix}`, slug: orgSlug, memberships: { create: { userId: ids.ownerId, role: MembershipRole.OWNER } } },
    });
    ids.organisationId = organisation.id;
    const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const event = await prisma.event.create({
      data: {
        organisationId: ids.organisationId,
        title: eventTitle,
        slug: eventSlug,
        startDateTime: start,
        endDateTime: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        timezone: "UTC",
        location: "Community Hall, 1 Test Street",
        status: EventStatus.PUBLISHED,
        privacyType: EventPrivacyType.PUBLIC,
        capacity: 1,
        page: { create: { isPublished: true, aboutHtml: "<p>A small meetup run by a crew.</p>" } },
        crewJoinLink: { create: { token: crewToken } },
      },
      include: { page: { select: { id: true } } },
    });
    ids.eventId = event.id;
    ids.eventPageId = event.page!.id;
  });

  test.afterAll(async () => {
    await discardQueuedTestEmail();
    if (ids.organisationId) await prisma.organisation.deleteMany({ where: { id: ids.organisationId } });
    if (ids.ownerId) await prisma.user.deleteMany({ where: { id: ids.ownerId } });
    await prisma.$disconnect();
  });
}
