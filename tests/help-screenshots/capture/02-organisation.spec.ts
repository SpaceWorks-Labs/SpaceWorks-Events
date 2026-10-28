import { expect, test } from "@playwright/test";
import { EMAILS } from "../seed/common";
import { dashboard, open, userPage } from "./browser";
import { capture, captureViewport, card, heading } from "./shots";
import { seed } from "./state";

/* Organisation pages and settings, creating things, and the account area. */

test.describe.configure({ timeout: 5 * 60_000 });

test("organisation members and profile", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, `${dashboard()}/members`);
  await capture(page, "organisation-members", [heading(page, "Team"), await card(heading(page, "Invite people")), await card(page.getByText("dev@example.org", { exact: false }))]);

  await open(page, `${dashboard()}/settings`);
  await capture(page, "organisation-settings-profile", await card(heading(page, "Profile")), { pad: 8 });
  await context.close();
});

test("organisation integrations", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, `${dashboard()}/settings/api`);
  await capture(page, "settings-api-access", [heading(page, "API access"), await card(page.getByText("Attendance sync", { exact: true }))]);

  await open(page, `${dashboard()}/settings/webhooks`);
  await capture(page, "settings-webhooks", [heading(page, "Webhooks"), page.getByText(/How to verify signatures/)]);

  await open(page, `${dashboard()}/settings/email`);
  await capture(page, "organisation-email-settings", page.locator("main"), { pad: 0, maxHeight: 1400 });

  await open(page, `${dashboard()}/settings/chat`);
  await capture(page, "organisation-chat-notifications", page.locator("main"), { pad: 0, maxHeight: 1600 });

  await open(page, `${dashboard()}/settings/payments`);
  await capture(page, "payment-settings", page.locator("main"), { pad: 0, maxHeight: 1700 });
  await context.close();
});

test("member IDs and the ticket designer", async ({ browser }) => {
  const { programmeId, ticketDesignId } = seed();
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, `${dashboard()}/ids/${programmeId}`);
  await capture(page, "member-id-programme-members", page.locator("main"), { pad: 0, maxHeight: 1500 });

  await open(page, `${dashboard()}/ticket-designs/${ticketDesignId}`);
  await captureViewport(page, "ticket-designer");
  await context.close();
});

test("creating an organisation, a series and an event", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, "/dashboard/org/new");
  await page.getByRole("textbox", { name: /^Name/ }).fill("Harbour Book Club");
  await page.getByRole("textbox", { name: /^Web address/ }).fill("harbour-book-club");
  await page.getByRole("textbox", { name: /^Description/ }).fill("Monthly meetups for readers in the harbour district.");
  await expect(page.getByText(/is available/)).toBeVisible();
  await capture(page, "create-organisation-form", [heading(page, /Create an organisation/), page.getByRole("button", { name: "Create organisation" })], { pad: 24 });

  await open(page, dashboard());
  await page.getByRole("button", { name: "New series" }).click();
  const series = page.getByRole("dialog");
  await series.getByRole("textbox", { name: /^Title/ }).fill("Saturday Repair Café");
  await series.getByRole("textbox", { name: /^Description/ }).fill("Fix things together, every other Saturday morning.");
  await series.getByLabel(/First occurrence start/).fill("2026-11-07T10:00");
  await series.getByLabel(/First occurrence end/).fill("2026-11-07T13:00");
  await series.getByRole("textbox", { name: /Recurrence/ }).fill("FREQ=WEEKLY;INTERVAL=2;BYDAY=SA;COUNT=10");
  await capture(page, "create-series-dialog", series, { pad: 0 });
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New event" }).first().click();
  const create = page.getByRole("dialog");
  await create.getByRole("textbox", { name: /^Title/ }).fill("Autumn Code & Coffee");
  await create.getByRole("textbox", { name: "About the event" }).fill("A relaxed morning of coding, coffee and good company. Bring a project or just come and say hello.");
  const tags = create.getByRole("textbox", { name: /^Tags/ });
  for (const tag of ["coffee", "coding"]) {
    await tags.fill(tag);
    await tags.press("Enter");
  }
  await capture(page, "create-event-dialog-basics", create, { pad: 0 });
  await context.close();
});

test("account settings", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, "/account");
  await capture(page, "account-profile", [await card(heading(page, "Profile")), await card(heading(page, "Appearance"))], { pad: 8 });

  await open(page, "/account/security");
  await capture(page, "account-security-two-step", await card(heading(page, /Two-step verification|Authenticator/)), { pad: 8 });

  await open(page, "/account/organisations");
  await capture(page, "account-organisations", await card(heading(page, "Your organisations")), { pad: 8 });
  await context.close();

  const member = await userPage(browser, EMAILS.buyer);
  await open(member.page, "/account/ids");
  await capture(member.page, "account-ids-wallet", member.page.locator("main"), { pad: 0, maxHeight: 1300 });
  await member.context.close();
});
