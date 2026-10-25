// Shared state, setup and helpers for tests/e2e/judging.spec.ts. Its tests run
// in order against one organisation and event created here.
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPermission, EventPrivacyType, EventStatus, MembershipRole, PrismaClient, RegistrationMode } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

export const prisma = new PrismaClient();
export const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
const password = "judging-journey-password";
export const ownerEmail = `judging-owner-${suffix}@example.test`;
export const judgeEmail = `judging-judge-${suffix}@example.test`;
export const orgSlug = `judging-${suffix}`;
export const eventSlug = `hack-${suffix}`;
const eventTitle = `Judged Hack ${suffix}`;
export const teams = {
  alpha: { team: `Alpha ${suffix}`, project: `Alpha Project ${suffix}`, leader: { name: "Ada Alpha", email: `judging-alpha-${suffix}@example.test` } },
  beta: { team: `Beta ${suffix}`, project: `Beta Project ${suffix}`, leader: { name: "Ben Beta", email: `judging-beta-${suffix}@example.test` } },
};
export const solo = { name: "Sol Solo", email: `judging-solo-${suffix}@example.test` };
const testEmails = [ownerEmail, judgeEmail, teams.alpha.leader.email, teams.beta.leader.email, solo.email];

let ownerId = "";
export let judgeId = "";
let organisationId = "";
export let eventId = "";
let ipCounter = 10;
export const manageTokens: Record<string, string> = {};

export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  // Its own TEST-NET-3 range: teams.spec.ts counts up through 198.51.100.x
  // in a parallel worker, and a shared IP shares the per-IP action limit.
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `203.0.113.${(ipCounter++ % 240) + 10}` });
  return context;
}

export async function waitForHydration(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).first().evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
}

async function signIn(page: Page, email: string) {
  await page.request.get("/api/auth/csrf");
  await page.request.get("/api/auth/session");
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login");
    const emailInput = page.getByRole("textbox", { name: /^Email/ });
    await expect.poll(() => emailInput.evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
    await emailInput.fill(email);
    await page.locator('input[type="password"]:visible').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const failed = page.getByRole("alert").filter({ hasText: "Invalid email or password" });
    await expect.poll(async () => !new URL(page.url()).pathname.startsWith("/login") || (await failed.count()) > 0, { timeout: 60_000 }).toBe(true);
    if (!new URL(page.url()).pathname.startsWith("/login")) return;
    if (attempt === 3) throw new Error(`Sign-in failed three times for ${email}`);
  }
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;
const sessions = new Map<string, StorageState>();

export async function userContext(browser: Browser, email: string) {
  if (!sessions.has(email)) {
    const signInContext = await newContext(browser);
    await signIn(await signInContext.newPage(), email);
    sessions.set(email, await signInContext.storageState());
    await signInContext.close();
  }
  const context = await newContext(browser, { storageState: sessions.get(email) });
  return { context, page: await context.newPage() };
}

export function collectPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

export type Payload = Record<string, unknown>;
export async function outboxPayload(kind: string, match: (payload: Payload) => boolean): Promise<Payload> {
  let found: Payload | undefined;
  await expect
    .poll(async () => {
      const rows = await prisma.outboxMessage.findMany({ where: { kind }, orderBy: { createdAt: "desc" }, select: { payload: true } });
      found = rows.map((row) => row.payload as Payload).find((payload) => payload && match(payload));
      return Boolean(found);
    }, { message: `waiting for a queued ${kind} email` })
    .toBe(true);
  return found!;
}

/** Registrations queue real emails; drop them before any worker pass can send to test addresses. */
export async function discardQueuedTestEmail() {
  const messages = await prisma.outboxMessage.findMany({ select: { id: true, payload: true } });
  const ids = messages.filter((message) => testEmails.includes(String((message.payload as Payload | null)?.to))).map((message) => message.id);
  if (ids.length) await prisma.outboxMessage.deleteMany({ where: { id: { in: ids } } });
}

export const dashboard = () => `/dashboard/${orgSlug}/event/${eventId}`;

/** Creates the organisation, its owner, the judge and the TEAM event before the suite, and removes them after. */
export function setUpJudgingSuite() {
  test.beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 12);
    ownerId = (await prisma.user.create({ data: { email: ownerEmail, name: "Judging Owner", passwordHash, emailVerified: new Date() } })).id;
    judgeId = (await prisma.user.create({ data: { email: judgeEmail, name: "Jude Judge", passwordHash, emailVerified: new Date() } })).id;
    organisationId = (
      await prisma.organisation.create({
        data: { name: `Judging ${suffix}`, slug: orgSlug, memberships: { create: { userId: ownerId, role: MembershipRole.OWNER } } },
      })
    ).id;
    const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    eventId = (
      await prisma.event.create({
        data: {
          organisationId,
          title: eventTitle,
          slug: eventSlug,
          startDateTime: start,
          endDateTime: new Date(start.getTime() + 24 * 60 * 60 * 1000),
          timezone: "UTC",
          location: "Makerspace",
          status: EventStatus.PUBLISHED,
          privacyType: EventPrivacyType.PUBLIC,
          registrationMode: RegistrationMode.TEAM,
          teamMinSize: 1,
          teamMaxSize: 4,
          page: { create: { isPublished: true, aboutHtml: "<p>Build and get judged.</p>" } },
        },
      })
    ).id;
    // The judge is a JUDGE-only event collaborator (no organisation membership).
    await prisma.eventCollaborator.create({ data: { eventId, userId: judgeId, permissions: [EventPermission.JUDGE] } });
  });

  test.afterAll(async () => {
    await discardQueuedTestEmail();
    if (organisationId) await prisma.organisation.deleteMany({ where: { id: organisationId } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, judgeId].filter(Boolean) } } });
    await prisma.$disconnect();
  });
}
