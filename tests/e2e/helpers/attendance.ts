import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus, MembershipRole, PrismaClient, RsvpStatus } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ipHeader } from "./client";

/*
 * Fixtures for tests/e2e/attendance-confirmation.spec.ts (docs/ATTENDANCE.md):
 * one organisation with an owner, an event with two confirmed guests and one
 * waitlisted guest, and helpers to sign in once and read queued links.
 */

export const prisma = new PrismaClient();
export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `attend-${suffix}`;
const password = "attendance-confirmation-browser-password";
const ownerEmail = `attend-owner-${suffix}@example.test`;
export const declinerEmail = `attend-decliner-${suffix}@example.test`;
export const comingEmail = `attend-coming-${suffix}@example.test`;
export const waitingEmail = `attend-waiting-${suffix}@example.test`;
export const declinerName = `Dora Decliner ${suffix.slice(0, 6)}`;
export const comingName = `Cal Coming ${suffix.slice(0, 6)}`;
export const note = `Train strike, sorry ${suffix.slice(0, 6)}`;
export const fixture = { organisationId: "", ownerId: "", eventId: "", declinerRsvpId: "" };
const testEmailSuffix = `${suffix}@example.test`;
let ipCounter = 10;

type Payload = Record<string, unknown>;

export function setUpAttendanceSuite() {
  test.beforeAll(async () => {
    fixture.organisationId = (await prisma.organisation.create({ data: { name: `Attendance ${suffix}`, slug: orgSlug } })).id;
    fixture.eventId = (await prisma.event.create({
      data: {
        organisationId: fixture.organisationId, title: `Attendance journey ${suffix}`, slug: `attendance-journey-${suffix}`,
        startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-01T12:00:00.000Z"), timezone: "UTC",
        location: "Main hall", status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, page: { create: { isPublished: true } },
      },
    })).id;
    fixture.declinerRsvpId = (await prisma.rSVP.create({ data: { eventId: fixture.eventId, attendeeKey: `guest:${declinerEmail}`, guestName: declinerName, guestEmail: declinerEmail, status: RsvpStatus.CONFIRMED } })).id;
    await prisma.rSVP.create({ data: { eventId: fixture.eventId, attendeeKey: `guest:${comingEmail}`, guestName: comingName, guestEmail: comingEmail, status: RsvpStatus.CONFIRMED } });
    // Never asked: only CONFIRMED guests are.
    await prisma.rSVP.create({ data: { eventId: fixture.eventId, attendeeKey: `guest:${waitingEmail}`, guestName: "Wendy Waiting", guestEmail: waitingEmail, status: RsvpStatus.WAITLISTED } });
    fixture.ownerId = (await prisma.user.create({
      data: { email: ownerEmail, name: "Attendance Owner", passwordHash: await bcrypt.hash(password, 12), emailVerified: new Date(), memberships: { create: { organisationId: fixture.organisationId, role: MembershipRole.OWNER } } },
    })).id;
  });
  test.afterAll(async () => {
    await discardQueuedTestEmail();
    if (fixture.organisationId) await prisma.organisation.delete({ where: { id: fixture.organisationId } });
    if (fixture.ownerId) await prisma.user.delete({ where: { id: fixture.ownerId } });
    await prisma.$disconnect();
  });
}

/** Queued email goes to test addresses; drop it before any worker pass tries to deliver it. */
export async function discardQueuedTestEmail() {
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' LIKE ${`%${testEmailSuffix}`}`;
}

/** Each context gets its own client address so per-IP limits don't couple tests. */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.setExtraHTTPHeaders({ [ipHeader]: `198.51.100.${ipCounter++}` });
  return context;
}

export async function waitForHydration(page: Page, selector: string) {
  await expect.poll(() => page.locator(selector).filter({ visible: true }).first().evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
}

let ownerSession: Awaited<ReturnType<BrowserContext["storageState"]>> | null = null;

/** Signs in once and reuses the session: repeated sign-ins would trip the per-minute auth limit. */
export async function ownerPage(browser: Browser) {
  if (!ownerSession) {
    const context = await newContext(browser);
    const page = await context.newPage();
    await page.request.get("/api/auth/csrf");
    await page.request.get("/api/auth/session");
    await page.goto("/login?callbackUrl=%2Fdashboard");
    await waitForHydration(page, "input[type=password]");
    await page.getByRole("textbox", { name: /^Email/ }).fill(ownerEmail);
    await page.locator('input[type="password"]:visible').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 60_000 });
    ownerSession = await context.storageState();
    await context.close();
  }
  const context = await newContext(browser, { storageState: ownerSession });
  return { context, page: await context.newPage() };
}

/** The raw link token exists only in the queued email. */
export async function queuedToken(rsvpId: string) {
  let token = "";
  await expect.poll(async () => {
    const rows = await prisma.outboxMessage.findMany({ where: { kind: "attendance-check", payload: { path: ["rsvpId"], equals: rsvpId } }, select: { payload: true } });
    token = String((rows[0]?.payload as Payload | undefined)?.token ?? "");
    return token.length;
  }, { message: "waiting for a queued attendance question" }).toBe(43);
  return token;
}

export const dashboard = (eventId = fixture.eventId) => `/dashboard/${orgSlug}/event/${eventId}`;
export const card = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Attendance confirmation" }) });

/** A second published event of the same organisation, for tests that must not change the main counts. */
export async function extraEvent(title: string, slug: string, extra: { capacity?: number; release?: boolean; } = {}) {
  return (await prisma.event.create({
    data: {
      organisationId: fixture.organisationId, title: `${title} ${suffix}`, slug: `${slug}-${suffix}`,
      startDateTime: new Date("2035-02-01T10:00:00.000Z"), endDateTime: new Date("2035-02-01T12:00:00.000Z"), timezone: "UTC",
      status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, capacity: extra.capacity, attendanceCheckReleaseOnDecline: extra.release ?? false,
      page: { create: { isPublished: true } },
    },
  })).id;
}
