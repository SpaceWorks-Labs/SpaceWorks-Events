import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus, MembershipRole, PrismaClient, RsvpStatus } from "@prisma/client";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

// Shared setup for the event crew organiser smoke (docs/CREW.md,
// tests/e2e/crew-smoke.spec.ts): an owner, a capacity-2 event, two seeded
// attendees, and the Guests → Crew helpers the steps use.

export const prisma = new PrismaClient();
export const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
export const ownerEmail = `crew-smoke-owner-${suffix}@example.test`;
export const password = "crew-smoke-password";
export const orgSlug = `crew-smoke-${suffix}`;
export const eventSlug = `crew-smoke-${suffix}`;
export const eventTitle = `Crew Smoke ${suffix}`;

export const asha = {
  name: "Asha Lead",
  email: `crew-asha-${suffix}@example.test`,
  food: "Vegetarian",
  role: "Logistics lead",
  bio: "Keeps the venue running.",
  linkedin: "https://www.linkedin.com/in/asha-lead",
};
// Step 4 renames Asha and changes her email; later steps use these.
export const ashaEdited = { name: "Asha Lead-Rao", email: `crew-asha-new-${suffix}@example.test`, role: "Venue lead" };
export const ben = { name: "Ben Helper", email: `crew-ben-${suffix}@example.test`, food: "vegetarian", role: "Volunteer" };
export const cleo = { name: "Cleo Stage", email: `crew-cleo-${suffix}@example.test`, role: "Stage manager" };
// Seeded attendees: Grace is converted into crew (step 7); Nora stays an attendee.
export const grace = { name: "Grace Guest", email: `crew-grace-${suffix}@example.test` };
export const nora = { name: "Nora Normal", email: `crew-nora-${suffix}@example.test` };
export const testEmails = [ownerEmail, asha.email, ashaEdited.email, ben.email, cleo.email, grace.email, nora.email, `crew-dup-${suffix}@example.test`];

/** Ids set by the suite's beforeAll and read by every step. */
export const state = { ownerId: "", organisationId: "", eventId: "", eventPageId: "", graceRsvp: { id: "", checkInToken: "" }, noraRsvp: { id: "", checkInToken: "" }, ipCounter: 10 };

export const dashboard = () => `/dashboard/${orgSlug}/event/${state.eventId}`;

/** Each context gets its own client address so per-IP rate limits never couple steps. */
export async function newContext(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser.newContext(options);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.51.101.${state.ipCounter++}` });
  return context;
}

export async function signIn(page: Page) {
  // A cold server compiles the auth routes on first use; warm them and allow retries.
  await page.request.get("/api/auth/csrf");
  await page.request.get("/api/auth/session");
  for (let attempt = 1; ; attempt++) {
    await page.goto("/login");
    const emailInput = page.getByRole("textbox", { name: /^Email/ });
    await hydrated(emailInput);
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { context, page, errors };
}

/** Waits for React to hydrate a control, so clicks and typing reach its handlers. */
export async function hydrated(locator: Locator) {
  await expect.poll(() => locator.first().evaluate((node) => Object.keys(node).some((key) => key.startsWith("__reactFiber"))), { timeout: 60_000 }).toBe(true);
}

/** Crew tickets queue real emails; drop them before any worker pass can send to test addresses. */
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

export async function openCrewTab(page: Page) {
  await page.goto(`${dashboard()}?tab=guests&sub=crew`);
  await expect(page.getByRole("tab", { name: /^Crew/ })).toHaveAttribute("aria-selected", "true");
  const addButton = page.getByRole("button", { name: "Add crew member" });
  await hydrated(addButton);
  return addButton;
}

export const crewList = (page: Page) => page.getByRole("list", { name: "Crew members" });
export const crewRow = (page: Page, name: string) => crewList(page).getByRole("listitem").filter({ hasText: name });

export async function crewRowNames(page: Page, names: string[]) {
  const texts = await crewList(page).getByRole("listitem").allTextContents();
  return texts.map((text) => names.find((name) => text.includes(name)) ?? "?");
}

export type NewMember = { name: string; email: string; food?: string; role?: string; bio?: string; linkedin?: string; show?: boolean };

/** Opens Add crew member and fills the form; the caller submits. */
export async function fillAddDialog(page: Page, member: NewMember) {
  await page.getByRole("button", { name: "Add crew member" }).click();
  const dialog = page.getByRole("dialog", { name: "Add crew member" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Name/).fill(member.name);
  await dialog.getByLabel(/^Email/).fill(member.email);
  if (member.food) await dialog.getByLabel(/^Food preference/).fill(member.food);
  if (member.role) await dialog.getByLabel(/^Role/).fill(member.role);
  if (member.bio) await dialog.getByLabel(/^Short bio/).fill(member.bio);
  if (member.linkedin) await dialog.getByLabel(/^LinkedIn URL/).fill(member.linkedin);
  const show = dialog.getByRole("switch", { name: /^Show on event page/ });
  await expect(show).toBeChecked();
  if (member.show === false) {
    await show.click();
    await expect(show).not.toBeChecked();
  }
  return dialog;
}

export async function addMember(page: Page, member: NewMember) {
  const dialog = await fillAddDialog(page, member);
  await dialog.getByRole("button", { name: "Add and send ticket" }).click();
  await expect(page.getByRole("status").filter({ hasText: `${member.name} added to the crew` })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expect(crewRow(page, member.name)).toHaveCount(1);
}

export const crewMemberByEmail = (email: string) =>
  prisma.eventCrewMember.findUnique({
    where: { eventId_email: { eventId: state.eventId, email } },
    select: { id: true, name: true, email: true, foodPreference: true, role: true, bio: true, linkedinUrl: true, showOnPage: true, joinedViaLink: true, sortOrder: true, rsvpId: true },
  });

/** Seeds the owner, the capacity-2 event and two attendees (Grace, Nora), and cleans up after. */
export function setUpCrewSmokeSuite() {
  test.beforeAll(async () => {
    const owner = await prisma.user.create({
      data: { email: ownerEmail, name: "Crew Smoke Owner", passwordHash: await bcrypt.hash(password, 12), emailVerified: new Date() },
    });
    state.ownerId = owner.id;
    const organisation = await prisma.organisation.create({
      data: { name: `Crew Smoke ${suffix}`, slug: orgSlug, memberships: { create: { userId: state.ownerId, role: MembershipRole.OWNER } } },
    });
    state.organisationId = organisation.id;
    const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const event = await prisma.event.create({
      data: {
        organisationId: state.organisationId,
        title: eventTitle,
        slug: eventSlug,
        startDateTime: start,
        endDateTime: new Date(start.getTime() + 3 * 60 * 60 * 1000),
        timezone: "UTC",
        location: "Community Hall, 1 Test Street",
        status: EventStatus.PUBLISHED,
        privacyType: EventPrivacyType.PUBLIC,
        capacity: 2,
        page: { create: { isPublished: true, aboutHtml: "<p>A meetup run by a crew.</p>" } },
      },
      include: { page: { select: { id: true } } },
    });
    state.eventId = event.id;
    state.eventPageId = event.page!.id;
    for (const [person, key] of [[grace, "graceRsvp"], [nora, "noraRsvp"]] as const) {
      state[key] = (await prisma.rSVP.create({
        data: { eventId: state.eventId, attendeeKey: `guest:${person.email}`, guestEmail: person.email, guestName: person.name, status: RsvpStatus.CONFIRMED },
        select: { id: true, checkInToken: true },
      }));
    }
  });

  test.afterAll(async () => {
    await discardQueuedTestEmail();
    if (state.organisationId) await prisma.organisation.deleteMany({ where: { id: state.organisationId } });
    if (state.ownerId) await prisma.user.deleteMany({ where: { id: state.ownerId } });
    await prisma.$disconnect();
  });
}
