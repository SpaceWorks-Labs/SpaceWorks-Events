import { expect, test } from "@playwright/test";
import { ORG_SLUG } from "../seed/common";
import { anonymousPage, open } from "./browser";
import { capture, captureViewport, heading } from "./shots";
import { seed } from "./state";

/* Signed-out pages: sign-in, Discover, registering for a free event, and a ticket. */

test.describe.configure({ timeout: 5 * 60_000 });

test("public pages: sign-in, Discover, event registration and ticket", async ({ browser }) => {
  const { events, ticketToken } = seed();
  const { context, page } = await anonymousPage(browser);

  await open(page, "/login");
  await expect(page.getByRole("tab", { name: "Create account" })).toBeVisible();
  await captureViewport(page, "login-page");

  await open(page, "/discover");
  await capture(page, "discover-page", [heading(page, /Discover/), page.getByRole("link", { name: /Riverside Tech Night: Building/ }).first()], { fullWidth: true, pad: 24 });

  await open(page, `/${ORG_SLUG}/${events.main.slug}`);
  await page.getByRole("button", { name: /Register/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /^Name/ }).fill("Sam Rivers");
  await dialog.getByRole("textbox", { name: /^Email/ }).fill("sam.rivers@example.org");
  await dialog.getByText("Yes", { exact: true }).click();
  await dialog.getByRole("textbox", { name: /dietary/ }).fill("Vegetarian");
  await capture(page, "event-registration-dialog", dialog, { pad: 0 });

  await open(page, `/ticket/${ticketToken}`);
  await capture(page, "ticket-page", [page.getByRole("link", { name: "Event page" }), page.getByText("Confirmed", { exact: true }), page.getByText("Save ticket", { exact: true }), page.getByText(/Cancel registration/)], { pad: 40 });
  await context.close();
});
