import { test } from "@playwright/test";
import { EMAILS } from "../seed/common";
import { open, userPage } from "./browser";
import { capture, card, heading } from "./shots";

/* The instance super-admin pages. The super-admin signs in with email and password only. */

test.describe.configure({ timeout: 5 * 60_000 });

test("super-admin pages", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.superAdmin);

  await open(page, "/super-admin");
  await capture(page, "super-admin-overview", page.locator("main"), { pad: 0, maxHeight: 1220 });
  await open(page, "/super-admin/operations");
  await capture(page, "super-admin-operations", page.locator("main"), { pad: 0, maxHeight: 1700 });
  await open(page, "/super-admin/security");
  await capture(page, "super-admin-security", page.locator("main"), { pad: 0, maxHeight: 1700 });
  await open(page, "/super-admin/settings");
  await capture(page, "super-admin-settings", [heading(page, "Instance settings"), await card(page.getByText("Backup configuration", { exact: true }))], { pad: 24 });
  await context.close();
});
