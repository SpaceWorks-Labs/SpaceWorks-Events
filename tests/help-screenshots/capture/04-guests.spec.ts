import { expect, test } from "@playwright/test";
import { EMAILS } from "../seed/common";
import { eventDashboard, open, userPage } from "./browser";
import { capture, capturePanel, card, heading, innerTabPanel, mark, resetViewport, tallViewport, visibleTabPanel } from "./shots";

/* Guests, emails, event settings (co-organisers and tickets) and an order's payment. */

test.describe.configure({ timeout: 5 * 60_000 });

test("guests", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("main", "?tab=guests"));
  const panel = visibleTabPanel(page);
  const rows = panel.getByText(/registered on|asked|joined waitlist/);
  await capture(page, "guests-people", [heading(panel, "Guests"), await card(rows.nth(9))], { pad: 20 });
  await capture(page, "guests-people-exports", [heading(panel, "Guests"), page.getByRole("button", { name: "Add guest" }), await card(rows.nth(1))], { pad: 20 });

  await tallViewport(page, 1400);
  // An open menu hides the rest of the page from role queries, so pin these first.
  const guestsHeading = await mark(heading(panel, "Guests"));
  const views = await mark(page.getByRole("button", { name: "Views" }));
  const addGuest = await mark(page.getByRole("button", { name: "Add guest" }));
  await views.click();
  const menu = page.getByRole("menu", { name: "Views" });
  await expect(menu).toBeVisible();
  await capture(page, "guests-views-menu", [guestsHeading, views, addGuest, menu], { pad: 24 });
  await page.keyboard.press("Escape");
  await resetViewport(page);

  await open(page, eventDashboard("main", "?tab=guests&sub=invites"));
  await capturePanel(page, "guests-invites", innerTabPanel(page));

  await open(page, eventDashboard("hack", "?tab=guests&sub=teams"));
  const teams = visibleTabPanel(page);
  await capturePanel(page, "guests-teams", teams, { maxHeight: 1300 });
  await context.close();
});

test("emails, settings and co-organisers", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("main", "?tab=emails"));
  await page.getByRole("button", { name: /Reminder before the event/ }).click();
  await expect(page.getByRole("textbox", { name: /^Subject/ })).not.toHaveValue("");
  await page.waitForTimeout(1500);
  await tallViewport(page);
  await capturePanel(page, "emails-composer", visibleTabPanel(page), { maxHeight: 1500 });
  await resetViewport(page);

  await open(page, eventDashboard("main", "?tab=settings"));
  await capture(page, "event-settings-co-organisers", await card(heading(page, "Co-organisers")), { pad: 8 });
  await context.close();
});

test("tickets and an order's payment", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("summit", "?tab=settings"));
  const tickets = page.locator('section[aria-labelledby="tickets-title"]');
  await tickets.getByRole("button", { name: "Add ticket" }).first().click();
  await expect(tickets.getByRole("textbox", { name: /Ticket name/ })).toBeVisible();
  await tickets.getByRole("textbox", { name: /Ticket name/ }).fill("Late bird");
  await capture(page, "event-settings-tickets", tickets, { pad: 8 });

  await open(page, eventDashboard("summit", "?tab=guests"));
  await page.getByRole("button", { name: "More actions for Tom Varghese" }).click();
  await page.getByRole("menuitem", { name: "Payment" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/RVWS-T9VG/)).toBeVisible();
  await capture(page, "guest-payment-dialog", dialog, { pad: 0 });
  await context.close();
});
