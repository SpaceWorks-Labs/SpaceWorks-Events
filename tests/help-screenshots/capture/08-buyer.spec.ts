import { expect, test } from "@playwright/test";
import { ORG_SLUG } from "../seed/common";
import { anonymousPage, open } from "./browser";
import { capture, heading } from "./shots";
import { seed } from "./state";

/* What a buyer sees: choosing tickets, the order page, asking for a refund, and claiming expenses. */

test.describe.configure({ timeout: 5 * 60_000 });

test("buying tickets and the order page", async ({ browser }) => {
  const { events, orderToken, claimTicketToken } = seed();
  const { context, page } = await anonymousPage(browser);

  await open(page, `/${ORG_SLUG}/${events.summit.slug}`);
  await page.getByRole("button", { name: /Get tickets/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Team of 4").first()).toBeVisible();
  await capture(page, "checkout-ticket-picker", dialog, { pad: 0 });
  await page.keyboard.press("Escape");

  // The buyer's own link to the order: no account needed.
  await open(page, `/order/${orderToken}`);
  await capture(page, "order-page", [page.locator("h1").first(), page.getByText("Download receipt (PDF)"), page.getByText("No attendee yet").first()], { pad: 32 });
  const refund = page.locator('section[aria-labelledby="order-refund-request"]');
  await capture(page, "order-refund-request", refund, { pad: 16 });

  await open(page, `/ticket/${claimTicketToken}`);
  await capture(page, "ticket-claim-expenses", page.locator("section").filter({ has: heading(page, "Claim expenses") }).first(), { pad: 16 });
  await context.close();
});
