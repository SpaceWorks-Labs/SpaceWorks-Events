import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { EventPrivacyType, EventStatus, MembershipRole, PrismaClient } from "@prisma/client";
import { expect, test, type Browser } from "@playwright/test";
import { zonedDatetimeLocalValue, zonedInputToIso } from "../../lib/timeZone";

/*
 * The New event dialog reads its times on the event's own clock (never the
 * browser's), and /discover never scrolls sideways on a phone, whatever the
 * length of an event's title, tag or place.
 */
test.describe.configure({ mode: "serial" });
const prisma = new PrismaClient();
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const orgSlug = `create-tz-${suffix}`;
const password = "create-event-timezone-password";
const ownerEmail = `create-tz-${suffix}@example.test`;
let organisationId = "";
let ownerId = "";

test.beforeAll(async () => {
  organisationId = (await prisma.organisation.create({ data: { name: `Create TZ ${suffix}`, slug: orgSlug } })).id;
  ownerId = (await prisma.user.create({
    data: {
      email: ownerEmail,
      name: "Timezone Owner",
      passwordHash: await bcrypt.hash(password, 12),
      emailVerified: new Date(),
      memberships: { create: { organisationId, role: MembershipRole.OWNER } },
    },
  })).id;
});

test.afterAll(async () => {
  if (organisationId) await prisma.organisation.delete({ where: { id: organisationId } });
  if (ownerId) await prisma.user.delete({ where: { id: ownerId } });
  await prisma.$disconnect();
});

async function ownerPage(browser: Browser) {
  // A browser clock far from the event's: the dialog must not use it.
  const context = await browser.newContext({ timezoneId: "Pacific/Auckland" });
  const page = await context.newPage();
  await page.context().setExtraHTTPHeaders({ [process.env.PLAYWRIGHT_TRUSTED_IP_HEADER || "cf-connecting-ip"]: "192.0.2.232" });
  await page.request.get("/api/auth/csrf");
  await page.goto("/login?callbackUrl=%2Fdashboard");
  await page.getByRole("textbox", { name: /^Email/ }).fill(ownerEmail);
  await page.locator('input[type="password"]:visible').fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { context, page };
}

test("the New event dialog reads start and end on the chosen event timezone", async ({ browser }) => {
  const { context, page } = await ownerPage(browser);
  await page.goto(`/dashboard/${orgSlug}`);
  await page.getByRole("button", { name: "New event" }).first().click();
  const dialog = page.getByRole("dialog");
  const title = `Clock check ${suffix}`;
  await dialog.getByRole("textbox", { name: /^Title/ }).fill(title);
  await dialog.getByRole("textbox", { name: "About the event" }).fill("Checks the event clock.");
  await dialog.getByRole("button", { name: "Next" }).click();

  // The suggested start is a whole hour on the event's clock, at least 30 minutes away.
  const start = dialog.getByLabel(/^Start/);
  await expect(start).toBeFocused();
  const suggested = await start.inputValue();
  expect(suggested).toMatch(/T\d{2}:00$/);
  const suggestedInstant = Date.parse(zonedInputToIso(suggested, "Asia/Kolkata")!);
  expect(suggestedInstant - Date.now()).toBeGreaterThan(29 * 60_000);

  await dialog.getByLabel(/^Timezone/).selectOption("America/New_York");
  // The earliest allowed start follows the chosen clock.
  const minimum = await start.getAttribute("min");
  expect(minimum?.slice(0, 13)).toBe(zonedDatetimeLocalValue(new Date(), "America/New_York").slice(0, 13));

  const startValue = zonedDatetimeLocalValue(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000), "America/New_York").slice(0, 11) + "18:00";
  await start.fill(startValue);
  await expect(dialog.getByLabel(/^End/)).toHaveValue(startValue.slice(0, 11) + "19:00");
  await dialog.getByRole("button", { name: "Next" }).click();
  await dialog.getByRole("textbox", { name: /^Location/ }).fill("Community Hall, 1 Test Street");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  await page.waitForURL(/\/dashboard\/[^/]+\/event\/[^/?]+/);
  const event = await prisma.event.findFirstOrThrow({ where: { organisationId, title }, select: { startDateTime: true, endDateTime: true, timezone: true } });
  expect(event.timezone).toBe("America/New_York");
  expect(event.startDateTime.toISOString()).toBe(zonedInputToIso(startValue, "America/New_York"));
  expect(event.endDateTime.getTime() - event.startDateTime.getTime()).toBe(60 * 60_000);
  await context.close();
});

test("a long unbroken event title, tag and place never widen /discover on a phone", async ({ browser }) => {
  const title = `Unbroken${suffix}`.padEnd(200, "x");
  const start = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const event = await prisma.event.create({
    data: {
      organisationId,
      title,
      slug: `unbroken-${suffix}`,
      startDateTime: start,
      endDateTime: new Date(start.getTime() + 2 * 60 * 60 * 1000),
      timezone: "UTC",
      location: `Hall${"y".repeat(300)}`,
      tags: ["z".repeat(80)],
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.PUBLIC,
      page: { create: { isPublished: true, aboutHtml: "<p>Checks that long words wrap.</p>" } },
    },
  });
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme, viewport: { width: 390, height: 844 }, isMobile: true });
      const page = await context.newPage();
      // The longest search the page accepts, echoed in the results heading.
      await page.goto(`/discover?q=${encodeURIComponent(title.slice(0, 120))}`);
      await expect(page.getByRole("heading", { level: 3, name: title })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, colorScheme).toBeLessThanOrEqual(1);
      await context.close();
    }
  } finally {
    await prisma.event.delete({ where: { id: event.id } });
  }
});
