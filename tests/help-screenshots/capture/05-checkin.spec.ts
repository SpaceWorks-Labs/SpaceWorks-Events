import { expect, test } from "@playwright/test";
import { EMAILS } from "../seed/common";
import { anonymousPage, eventDashboard, hydrated, open, userPage } from "./browser";
import { capture, captureViewport, card, heading } from "./shots";

/* The door station, the check-in desk, badges, offline check-in and custom lists. */

test.describe.configure({ timeout: 5 * 60_000 });

test("check-in", async ({ browser }) => {
  // Turning on the door station needs a recent sign-in.
  const { context, page } = await userPage(browser, EMAILS.owner, { fresh: true });

  await open(page, eventDashboard("main", "?tab=check-in"));
  const station = await card(heading(page, "Door station"));
  await station.getByRole("button", { name: "Turn on station" }).click();
  await expect(station.getByRole("button", { name: "Hide" })).toBeVisible({ timeout: 30_000 });
  await station.getByRole("button", { name: "Hide" }).click();
  await expect(station.getByRole("button", { name: "Show PIN" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /enabled/ })).toHaveCount(0, { timeout: 15_000 });
  await capture(page, "door-station-card", station, { pad: 8 });
  const stationUrl = (await station.locator("p.font-mono").innerText()).trim();

  await open(page, `${eventDashboard("main")}/check-in`);
  await capture(page, "check-in-desk", [heading(page, "Check-in desk"), await card(page.getByText("Manual code", { exact: true })), await card(page.getByText("Search attendees", { exact: true }))], { pad: 16 });

  await page.getByRole("switch", { name: "ID card printing" }).click();
  await page.getByRole("button", { name: "Design badge" }).click();
  const badges = page.getByRole("dialog");
  await expect(badges).toBeVisible();
  await capture(page, "badge-designer", badges, { pad: 0 });
  await page.keyboard.press("Escape");
  await page.getByRole("switch", { name: "ID card printing" }).click();

  await page.getByRole("button", { name: "Make available offline" }).click();
  await expect(page.getByText("Offline check-in ready")).toBeVisible({ timeout: 30_000 });
  await capture(page, "check-in-offline-ready", [heading(page, "Check-in desk"), await card(page.getByText("Offline check-in ready"))], { pad: 16 });

  // A fresh load drops the "saved on this device" toast.
  await open(page, `${eventDashboard("main")}/check-in`);
  await page.getByRole("link", { name: /Swag collection/ }).click();
  await hydrated(page);
  await expect(heading(page, /Guests for Swag collection/)).toBeVisible();
  await capture(page, "check-in-list-desk", [page.getByRole("link", { name: /^Entry/ }), page.getByText("Manage lists", { exact: true }), page.getByRole("list", { name: "Guests for Swag collection" }).getByRole("listitem").nth(4)], { pad: 16 });

  // The station link is meant for a volunteer's phone without an account.
  const volunteer = await anonymousPage(browser);
  await open(volunteer.page, stationUrl);
  await expect(volunteer.page.getByText(/station PIN/i).first()).toBeVisible();
  await captureViewport(volunteer.page, "door-station-pin");
  await volunteer.context.close();
  await context.close();
});
