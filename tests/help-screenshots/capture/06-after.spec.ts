import { expect, test } from "@playwright/test";
import { EMAILS } from "../seed/common";
import { eventDashboard, open, userPage } from "./browser";
import { capture, capturePanel, heading, resetViewport, tallViewport, visibleTabPanel } from "./shots";

/* Feedback and certificates, analytics with money, and event finance. */

test.describe.configure({ timeout: 5 * 60_000 });

test("feedback, certificates and analytics", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("past", "?tab=feedback"));
  await capturePanel(page, "feedback-tab", visibleTabPanel(page), { maxHeight: 1400 });

  // A taller window shows the whole designer, with the name layer selected.
  await tallViewport(page, 1250);
  await page.getByRole("button", { name: "Design certificate" }).click();
  const designer = page.getByRole("dialog", { name: "Design certificate" });
  await expect(designer).toBeVisible();
  await designer.getByText("{{name}}", { exact: true }).click();
  await designer.evaluate((node) => node.querySelectorAll("*").forEach((element) => { element.scrollTop = 0; }));
  await capture(page, "certificate-designer", designer, { pad: 0 });
  await page.keyboard.press("Escape");
  await resetViewport(page);

  await open(page, eventDashboard("past", "?tab=analytics"));
  await capturePanel(page, "analytics-tab", visibleTabPanel(page));
  await context.close();
});

test("money and finance on a paid event", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("summit", "?tab=analytics"));
  await capture(page, "analytics-money-card", page.locator('section[aria-labelledby="analytics-money-title"]'), { pad: 8 });

  await open(page, eventDashboard("summit", "?tab=finance"));
  const claims = page.locator('section[aria-labelledby="claims-title"]');
  await capture(page, "finance-overview", [heading(page, "Money in and out"), claims]);
  await capture(page, "finance-refund-request", page.locator('section[aria-labelledby="refund-requests-title"]'), { pad: 8 });
  await context.close();
});
