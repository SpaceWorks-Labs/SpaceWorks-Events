import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { EMAILS, coverSvg } from "../seed/common";
import { eventDashboard, open, userPage } from "./browser";
import { capture, card, heading, innerTabPanel } from "./shots";

/* An event's overview, details, publishing, cover photo, event page and programme. */

test.describe.configure({ timeout: 5 * 60_000 });

test("event overview, details and publishing", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("main"));
  await capture(page, "event-overview-share-card", await card(heading(page, "Share")), { pad: 8 });

  await open(page, eventDashboard("draft"));
  const readiness = await card(page.getByText(/things? left/).first());
  await capture(page, "event-dashboard-overview", [page.getByRole("link", { name: "All events" }), readiness]);
  await capture(page, "event-overview-readiness", readiness, { pad: 8 });

  await open(page, eventDashboard("main", "?tab=page&sub=details"));
  await capture(page, "event-details-form", [await card(page.getByText("Public URL")), await card(heading(page, /^Basics/))]);
  const publishing = await card(heading(page, "Publishing"));
  await capture(page, "event-publishing-section", publishing, { pad: 8 });
  await capture(page, "publishing-sign-ups", [publishing.getByText("Sign-ups", { exact: true }), publishing.getByText(/Sign-ups close 2 hours before the start/)], { pad: 12 });

  await context.close();
});

test("cover photo editor", async ({ browser }, testInfo) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  const cover = testInfo.outputPath("cover.png");
  await sharp(Buffer.from(coverSvg("#0f766e", "#f59e0b"))).png().toFile(cover);
  await open(page, eventDashboard("main", "?tab=page&sub=details"));
  await (await card(heading(page, "Cover image"))).locator('input[type="file"]').setInputFiles(cover);
  const dialog = page.getByRole("dialog", { name: "Edit cover photo" });
  await expect(dialog).toBeVisible();
  await capture(page, "cover-photo-editor", dialog, { pad: 0 });
  await context.close();
});

test("event page content and registration form", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("main", "?tab=page&sub=page"));
  await capture(page, "event-page-sections", [await card(heading(page, "Colour")), await card(heading(page, "Sections"))]);

  const speakers = page.locator("section").filter({ has: heading(page, "Speakers") });
  await speakers.getByRole("button", { name: /^Add speaker/i }).click();
  const form = speakers.locator("form").first();
  await form.getByRole("textbox", { name: /^Name/ }).fill("Priya Natarajan");
  await form.getByRole("textbox", { name: /^Headline/ }).fill("Developer advocate");
  await form.getByRole("textbox", { name: /^Organisation/ }).fill("Quay Cloud");
  await capture(page, "event-page-speaker-form", [heading(speakers, "Speakers"), form]);

  await open(page, eventDashboard("main", "?tab=page&sub=registration"));
  await capture(page, "registration-form-builder", innerTabPanel(page), { maxHeight: 1300 });
  await context.close();
});

test("programme schedule", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, `${eventDashboard("main")}/schedule`);
  await capture(page, "programme-schedule", [heading(page, "Programme schedule"), await card(page.getByText("Workshop Room", { exact: true }).last())], { maxHeight: 1500 });
  await capture(page, "programme-live-delay", await card(page.getByText(/5 sessions · delays stay in this track/)), { pad: 8 });
  await context.close();
});
