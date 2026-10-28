import { createHash, randomBytes } from "node:crypto";
import { RsvpStatus } from "@prisma/client";
import { expect, test } from "@playwright/test";
import {
  card, comingEmail, comingName, dashboard, declinerEmail, declinerName, discardQueuedTestEmail, extraEvent, fixture,
  newContext, note, ownerPage, prisma, queuedToken, setUpAttendanceSuite, suffix, waitForHydration, waitingEmail,
} from "./helpers/attendance";

/*
 * Attendance confirmation ("Are you still coming?", docs/ATTENDANCE.md): the
 * organiser asks from the Emails tab after a preview and an explicit
 * confirmation; a guest opens their link and answers No with a note; the
 * organiser sees the reply in the card, the People filter and badge, and the
 * CSV. The link is a private, unindexed capability; a bad token is a real
 * 404; with release on a No shows the released screen; a link can be shared
 * by hand from the guest menu.
 */
test.describe.configure({ mode: "serial" });
setUpAttendanceSuite();

let declinerToken = "";
let comingToken = "";

test("nothing is asked until the organiser previews and confirms the send", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await ownerPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(`${dashboard()}?tab=emails`);
  await expect(card(page)).toBeVisible({ timeout: 60_000 });
  await expect(card(page)).toContainText("Not sent yet. 2 confirmed guests would be asked.");
  expect(await prisma.attendanceCheck.count({ where: { eventId: fixture.eventId } })).toBe(0);

  const ask = card(page).getByRole("button", { name: "Ask guests to confirm attendance" });
  await waitForHydration(page, "section button");
  await ask.click();
  const preview = page.getByRole("dialog", { name: "Ask 2 guests to confirm" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("2 confirmed guests");
  await expect(preview).toContainText("Each guest gets one email");
  // Cancelling the preview sends nothing.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toBeHidden();
  expect(await prisma.attendanceCheck.count({ where: { eventId: fixture.eventId } })).toBe(0);

  await ask.click();
  await page.getByRole("dialog", { name: "Ask 2 guests to confirm" }).getByRole("button", { name: "Send to 2 guests" }).click();
  await expect(page.getByText("Asking 2 guests to confirm. Emails are on their way.")).toBeVisible({ timeout: 20_000 });

  declinerToken = await queuedToken(fixture.declinerRsvpId);
  const coming = await prisma.rSVP.findFirstOrThrow({ where: { eventId: fixture.eventId, guestEmail: comingEmail } });
  comingToken = await queuedToken(coming.id);
  await discardQueuedTestEmail();
  expect(await prisma.attendanceCheck.count({ where: { eventId: fixture.eventId } })).toBe(2);
  expect(await prisma.attendanceCheck.count({ where: { rsvp: { guestEmail: waitingEmail } } })).toBe(0);

  await expect(card(page)).toContainText("Asked 2 guests", { timeout: 20_000 });
  await expect(card(page)).toContainText("by Attendance Owner");
  await expect(card(page).getByRole("button", { name: "Ask newly confirmed guests" })).toBeDisabled();
  expect(errors).toEqual([]);
  await context.close();
});

test("the guest answers No with a note from their private link", async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const response = await page.goto(`/attend/${declinerToken}?answer=no`);
  expect(response?.status()).toBe(200);
  const headers = response!.headers();
  const cacheControl = headers["cache-control"] ?? "";
  // `next dev` replaces the proxy's header with its own `no-cache, must-revalidate`.
  if (process.env.PLAYWRIGHT_PRODUCTION_SERVER === "1") {
    expect(cacheControl).toContain("no-store");
    expect(cacheControl).toContain("private");
  } else {
    expect(cacheControl).toMatch(/no-store|no-cache/);
  }
  expect(cacheControl).not.toMatch(/public|s-maxage/);
  expect(headers["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  await expect(page.getByRole("heading", { level: 1 })).toContainText(`Attendance journey ${suffix}`);
  const registration = page.getByRole("region", { name: "Your registration" });
  await expect(registration).toContainText(declinerName);
  await expect(registration).toContainText(declinerEmail);
  await expect(page.locator("body")).not.toContainText(comingName);
  await expect(page.locator('a[href*="/ticket/"]')).toHaveCount(0);

  await waitForHydration(page, "form button");
  // The email's No button preselects No; it never submits on its own.
  await expect(page.getByRole("radio", { name: "No, I can't make it" })).toBeChecked();
  expect((await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: fixture.declinerRsvpId } })).response).toBeNull();

  await page.getByRole("textbox", { name: /Note for the organisers/ }).fill(note);
  await page.getByRole("button", { name: "Send my answer" }).click();
  await expect(page.getByText("Thanks for letting us know")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status")).toContainText(note);
  await expect.poll(async () => (await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: fixture.declinerRsvpId } })).response).toBe("NOT_ATTENDING");
  // Release is off by default: the place is kept.
  expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: fixture.declinerRsvpId } })).status).toBe(RsvpStatus.CONFIRMED);

  const yes = await context.newPage();
  await yes.goto(`/attend/${comingToken}?answer=yes`);
  await waitForHydration(yes, "form button");
  await expect(yes.getByRole("radio", { name: "Yes, I'll be there" })).toBeChecked();
  await yes.getByRole("button", { name: "Send my answer" }).click();
  await expect(yes.getByText("Thanks, see you there!")).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
  await context.close();
});

test("a bad or unknown link is a real 404 and never indexed", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  for (const path of [`/attend/${"x".repeat(43)}`, "/attend/not-a-token", `/attend/${declinerToken}x`]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(page.locator("body")).not.toContainText(declinerEmail);
  }
  expect(await (await page.request.get("/robots.txt")).text()).toContain("Disallow: /attend/");
  await context.close();
});

test("the organiser sees the replies in the Emails card, the People filter and the CSV", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context, page } = await ownerPage(browser);
  await page.goto(`${dashboard()}?tab=emails`);
  const status = card(page).getByRole("status");
  await expect(status).toContainText("Asked 2 guests", { timeout: 60_000 });
  const stat = (label: string) => status.locator("div", { has: page.getByText(label, { exact: true }) }).locator("dd");
  await expect(stat("Coming")).toHaveText("1");
  await expect(stat("Not coming")).toHaveText("1");
  await expect(stat("No reply")).toHaveText("0");

  await page.goto(`${dashboard()}?tab=guests&sub=people`);
  await waitForHydration(page, "#guest-search");
  const filter = page.getByRole("combobox", { name: "Attendance confirmation" });
  await expect(filter).toBeVisible();
  await filter.click();
  await expect(page.getByRole("option", { name: "Coming (1)", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "Not coming (1)", exact: true }).click();
  const exportLink = page.getByRole("link", { name: "Export CSV" });
  await expect(exportLink).toHaveAttribute("href", `/api/exports/events/${fixture.eventId}/attendees?attendance=notComing`);
  const list = page.getByRole("list").filter({ hasText: declinerName });
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(comingName)).toHaveCount(0);
  await expect(list).toContainText("Not coming");
  await expect(list).toContainText(note);

  const csv = await page.request.get((await exportLink.getAttribute("href"))!);
  expect(csv.status()).toBe(200);
  const lines = (await csv.text()).replace(/^﻿/, "").trim().split("\n");
  expect(lines[0]!.split(",").slice(-2)).toEqual(["Attendance confirmation", "Attendance note"]);
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(declinerEmail);
  expect(lines[1]).toContain("Not coming");
  expect(lines[1]).toContain(note);
  await context.close();
});

test("with release on, a No shows the released screen and promotes the waitlist", async ({ browser }) => {
  test.setTimeout(90_000);
  const releaseEventId = await extraEvent("Release journey", "release-journey", { capacity: 1, release: true });
  const leaving = await prisma.rSVP.create({ data: { eventId: releaseEventId, attendeeKey: `guest:leave-${suffix}@example.test`, guestName: "Lee Leaving", guestEmail: `leave-${suffix}@example.test`, status: RsvpStatus.CONFIRMED } });
  const waiting = await prisma.rSVP.create({ data: { eventId: releaseEventId, attendeeKey: `guest:next-${suffix}@example.test`, guestName: "Nia Next", guestEmail: `next-${suffix}@example.test`, status: RsvpStatus.WAITLISTED } });
  // The raw link normally exists only in the email; mint one directly for this test.
  const token = randomBytes(32).toString("base64url");
  await prisma.attendanceCheck.create({ data: { rsvpId: leaving.id, eventId: releaseEventId, tokenHash: createHash("sha256").update(token).digest("hex"), sentAt: new Date() } });

  const context = await newContext(browser);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`/attend/${token}?answer=no`);
  await waitForHydration(page, "form button");
  await expect(page.getByText("Answering No releases your place")).toBeVisible();
  await page.getByRole("button", { name: "Release my place" }).click();
  // Regression: the Server Action must not re-render the (now retired) link as a 404.
  await expect(page.getByRole("heading", { name: "Your place has been released" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Your registration" })).toContainText("Lee Leaving");

  expect(await prisma.rSVP.findUnique({ where: { id: leaving.id } })).toBeNull();
  expect((await prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe(RsvpStatus.CONFIRMED);
  expect((await page.goto(`/attend/${token}`))?.status()).toBe(404);
  expect(errors).toEqual([]);
  await context.close();
});

test("the organiser shares one guest's link by hand, without an email", async ({ browser }) => {
  test.setTimeout(120_000);
  const shareEventId = await extraEvent("Share journey", "share-journey");
  const sharedName = `Sam Shared ${suffix.slice(0, 6)}`;
  const sharedEmail = `share-${suffix}@example.test`;
  const shared = await prisma.rSVP.create({ data: { eventId: shareEventId, attendeeKey: `guest:${sharedEmail}`, guestName: sharedName, guestEmail: sharedEmail, status: RsvpStatus.CONFIRMED } });

  const { context, page } = await ownerPage(browser);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${dashboard(shareEventId)}?tab=guests&sub=people`);
  await waitForHydration(page, "#guest-search");

  async function createLink(button: string) {
    const row = page.getByRole("listitem").filter({ hasText: sharedName }).first();
    await row.getByRole("button", { name: `More actions for ${sharedName}` }).click();
    await page.getByRole("menuitem", { name: "Share attendance link" }).click();
    const dialog = page.getByRole("dialog", { name: `Share ${sharedName}'s attendance link` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: button }).click();
    const field = dialog.getByRole("textbox", { name: "Attendance link" });
    await expect(field).toHaveValue(/\/attend\/[A-Za-z0-9_-]{43}$/, { timeout: 20_000 });
    const url = await field.inputValue();
    await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
    return new URL(url).pathname;
  }

  const first = await createLink("Create link");
  expect(await prisma.outboxMessage.count({ where: { kind: "attendance-check", payload: { path: ["rsvpId"], equals: shared.id } } })).toBe(0);
  await expect(page.getByRole("listitem").filter({ hasText: sharedName }).first()).toContainText("No reply", { timeout: 20_000 });
  const second = await createLink("Create new link");
  expect(second).not.toBe(first);

  const guestContext = await newContext(browser);
  const guestPage = await guestContext.newPage();
  expect((await guestPage.goto(first))?.status()).toBe(404);
  expect((await guestPage.goto(second))?.status()).toBe(200);
  await expect(guestPage.getByRole("region", { name: "Your registration" })).toContainText(sharedName);
  await waitForHydration(guestPage, "form button");
  await guestPage.getByRole("radio", { name: "Yes, I'll be there" }).check();
  await guestPage.getByRole("button", { name: "Send my answer" }).click();
  await expect(guestPage.getByText("Thanks, see you there!")).toBeVisible({ timeout: 20_000 });
  await guestContext.close();

  expect((await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: shared.id } })).response).toBe("ATTENDING");
  expect(errors).toEqual([]);
  await context.close();
});
