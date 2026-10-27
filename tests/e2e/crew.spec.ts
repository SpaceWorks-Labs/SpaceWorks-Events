import { EventPageSectionType, RsvpStatus } from "@prisma/client";
import { expect, test } from "@playwright/test";
import {
  attendee,
  collectPageErrors,
  crewMember,
  crewPath,
  crewToken,
  discardQueuedTestEmail,
  eventSlug,
  eventTitle,
  expectCapabilityHeaders,
  ids,
  lateAttendee,
  newContext,
  orgSlug,
  ownerContext,
  prisma,
  registerAttendee,
  setUpCrewSuite,
  waitForHydration,
} from "./helpers/crew";

// Event crew journeys (docs/CREW.md). One ordered story: a crew member signs up
// through the private crew link, their free ticket never takes an attendee
// place, they appear on the public page only once the Crew section is on and
// they are shown, and the organiser sees them (with their food preference) and
// the link in Guests → Crew. The generous timeout covers first-visit route
// compilation on a cold dev server.
test.describe.configure({ mode: "serial", timeout: 120_000 });

setUpCrewSuite();

test("the crew link is a private, unindexed page and unknown tokens 404", async ({ browser }) => {
  const context = await newContext(browser);
  const body = await expectCapabilityHeaders(await context.request.get(crewPath), "/crew/:token");
  expect(body).toContain(eventTitle);
  // Token-shaped but unknown, and malformed values, share the generic 404.
  const unknown = await context.request.get("/crew/not-a-real-token-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
  expect(unknown.status()).toBe(404);
  expect(await unknown.text()).not.toContain(eventTitle);
  expect((await context.request.get("/crew/short")).status()).toBe(404);
  await context.close();
});

test("a crew member signs up through the link and starts hidden with a crew ticket", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await page.goto(crewPath);
  await expect(page.getByRole("heading", { level: 1, name: `Join the crew for ${eventTitle}` })).toBeVisible();
  await waitForHydration(page, 'input[autocomplete="name"]');
  await page.getByLabel(/^Name/).fill(crewMember.name);
  await page.getByLabel(/^Email/).fill(crewMember.email);
  // The food field has a suggestion list, so it is a combobox: address it by its label.
  await page.getByLabel(/^Food preference/).fill(crewMember.food);
  await page.getByLabel(/^Role/).fill(crewMember.role);
  await page.getByRole("button", { name: "Join the crew" }).click();
  await expect(page.getByRole("status").filter({ hasText: "your crew sign-up is in" })).toBeVisible();

  const member = await prisma.eventCrewMember.findFirstOrThrow({
    where: { eventId: ids.eventId },
    select: { name: true, email: true, foodPreference: true, role: true, showOnPage: true, joinedViaLink: true, rsvp: { select: { status: true, isCrew: true, teamId: true } } },
  });
  expect(member).toEqual({
    name: crewMember.name,
    email: crewMember.email,
    foodPreference: crewMember.food,
    role: crewMember.role,
    showOnPage: false,
    joinedViaLink: true,
    rsvp: { status: RsvpStatus.CONFIRMED, isCrew: true, teamId: null },
  });
  expect(await prisma.eventCrewMember.count({ where: { eventId: ids.eventId } })).toBe(1);
  await discardQueuedTestEmail();
  expect(errors).toEqual([]);
  await context.close();
});

test("the crew ticket never takes the event's only attendee place", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  const joinCard = page.locator("section", { has: page.locator("#join-title") });

  // Crew count as going, but the single place is still free.
  await page.goto(`/${orgSlug}/${eventSlug}`);
  await expect(joinCard.getByText("1 going")).toBeVisible();
  await expect(joinCard.getByText("1 spot left")).toBeVisible();

  const first = await registerAttendee(browser, attendee);
  expect(first.status, first.text).toBe(200);
  await page.reload();
  await expect(joinCard.getByText("2 going")).toBeVisible();
  await expect(joinCard.getByText("0 spots left")).toBeVisible();

  // Now the place is taken: the next attendee waits.
  const second = await registerAttendee(browser, lateAttendee);
  expect(second.status, second.text).toBe(200);
  const statuses = await prisma.rSVP.findMany({ where: { eventId: ids.eventId }, select: { guestEmail: true, status: true, isCrew: true }, orderBy: { createdAt: "asc" } });
  expect(statuses).toEqual([
    { guestEmail: crewMember.email, status: RsvpStatus.CONFIRMED, isCrew: true },
    { guestEmail: attendee.email, status: RsvpStatus.CONFIRMED, isCrew: false },
    { guestEmail: lateAttendee.email, status: RsvpStatus.WAITLISTED, isCrew: false },
  ]);
  await discardQueuedTestEmail();
  expect(errors).toEqual([]);
  await context.close();
});

test("the public Crew section appears only when switched on, without email or food", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  const crewHeading = page.getByRole("heading", { level: 2, name: "Crew", exact: true });

  // No saved CREW section: nothing about the crew is published.
  await page.goto(`/${orgSlug}/${eventSlug}`);
  await expect(page.getByRole("heading", { level: 1, name: eventTitle })).toBeVisible();
  await expect(crewHeading).toHaveCount(0);
  await expect(page.getByText(crewMember.name)).toHaveCount(0);

  // Section on, but the member is still hidden (joined via the link): still no section.
  await prisma.eventPageSection.upsert({
    where: { pageId_type: { pageId: ids.eventPageId, type: EventPageSectionType.CREW } },
    create: { pageId: ids.eventPageId, type: EventPageSectionType.CREW, isVisible: true, sortOrder: 99 },
    update: { isVisible: true },
  });
  await page.reload();
  await expect(crewHeading).toHaveCount(0);

  // The organiser shows them: the card has name and role only.
  await prisma.eventCrewMember.updateMany({ where: { eventId: ids.eventId }, data: { showOnPage: true } });
  await page.reload();
  await expect(crewHeading).toBeVisible();
  const section = page.locator("section#crew");
  // The avatar repeats the name for screen readers, so match the visible card text.
  await expect(section.getByRole("paragraph").filter({ hasText: crewMember.name })).toBeVisible();
  await expect(section.getByText(crewMember.role, { exact: true })).toBeVisible();

  // Neither the rendered page nor its raw HTML (including the RSC payload) carries private fields.
  const html = await page.content();
  expect(html).not.toContain(crewMember.email);
  expect(html).not.toContain(crewMember.food);
  const raw = await (await context.request.get(`/${orgSlug}/${eventSlug}`)).text();
  expect(raw).toContain(crewMember.name);
  expect(raw).not.toContain(crewMember.email);
  expect(raw).not.toContain(crewMember.food);
  expect(raw).not.toContain(crewToken);
  expect(errors).toEqual([]);
  await context.close();
});

test("the organiser sees the crew member, their food preference and the sign-up link in Guests → Crew", async ({ browser }) => {
  const { context, page } = await ownerContext(browser);
  const errors = collectPageErrors(page);
  await page.goto(`/dashboard/${orgSlug}/event/${ids.eventId}?tab=guests&sub=crew`);
  await expect(page.getByRole("tab", { name: /^Crew/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 2, name: "Crew", exact: true })).toBeVisible();

  const row = page.getByRole("list", { name: "Crew members" }).getByRole("listitem").filter({ hasText: crewMember.name });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(crewMember.role);
  await expect(row).toContainText(crewMember.email);
  await expect(row).toContainText(crewMember.food);
  await expect(row.getByRole("switch")).toBeChecked();

  // Catering summary groups the crew's food preferences.
  await expect(page.getByRole("list", { name: "Crew food preferences" })).toContainText(crewMember.food);

  const linkCard = page.locator("section", { has: page.locator("#crew-link-title") });
  await expect(linkCard.getByRole("heading", { name: "Crew sign-up link" })).toBeVisible();
  const linkInput = linkCard.getByRole("textbox", { name: "Sign-up link" });
  await expect(linkInput).toHaveValue(new RegExp(`/crew/${crewToken}$`));
  await expect(linkCard.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(linkCard.getByRole("button", { name: "Replace link" })).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});
