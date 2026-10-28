import { EventPrivacyType, RegistrationMode } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { appOrigin } from "./client";
import {
  approvalLeader,
  approvalMember,
  approvalSlug,
  approvalTeamName,
  approvalTitle,
  collectPageErrors,
  createTeamEvent,
  discardQueuedTestEmail,
  eventId,
  leader,
  member,
  newContext,
  organisationId,
  orgSlug,
  ownerContext,
  prisma,
  suffix,
  teamName,
  waitForHydration,
} from "./teams";

let approvalEventId = "";

/** Organiser steps: approving a team, finding it at the check-in desk, and the create-event team size check. */
export function teamsApprovalTests() {
  test("an organiser approves a team on an approval-required event and both tickets show it", async ({ browser }) => {
    const approvalEvent = await createTeamEvent({ slug: approvalSlug, title: approvalTitle, privacyType: EventPrivacyType.APPROVAL_REQUIRED });
    approvalEventId = approvalEvent.id;
    await prisma.event.update({ where: { id: approvalEventId }, data: { registrationMode: RegistrationMode.TEAM, teamMaxSize: 4 } });

    // Both people register through the same endpoint the public form posts to.
    const leaderContext = await newContext(browser);
    const created = await leaderContext.request.post("/api/rsvp", {
      headers: { origin: appOrigin },
      data: { orgSlug, eventSlug: approvalSlug, guestEmail: approvalLeader.email, name: approvalLeader.name, answers: {}, team: { mode: "create", name: approvalTeamName } },
    });
    expect(created.status(), await created.text()).toBe(200);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId: approvalEventId } });
    expect(team.status).toBe("PENDING_APPROVAL");
    const memberContext = await newContext(browser);
    const joined = await memberContext.request.post("/api/rsvp", {
      headers: { origin: appOrigin },
      data: { orgSlug, eventSlug: approvalSlug, guestEmail: approvalMember.email, name: approvalMember.name, answers: {}, team: { mode: "join", joinToken: team.joinToken } },
    });
    expect(joined.status(), await joined.text()).toBe(200);
    await discardQueuedTestEmail();

    const { context, page } = await ownerContext(browser);
    const errors = collectPageErrors(page);
    // Below the minimum, Approve stays reachable by keyboard and explains itself in visible text.
    await prisma.event.update({ where: { id: approvalEventId }, data: { teamMinSize: 3 } });
    await page.goto(`/dashboard/${orgSlug}/event/${approvalEventId}?tab=guests`);
    await page.getByRole("tab", { name: /^Teams/ }).click();
    const teams = page.getByRole("list", { name: "Teams" });
    await expect(teams.getByText(approvalTeamName)).toBeVisible();
    const approve = teams.getByRole("button", { name: `Approve team ${approvalTeamName}` });
    await expect(approve).toHaveAttribute("aria-disabled", "true");
    await expect(approve).not.toHaveAttribute("title");
    await expect(approve).toHaveAccessibleDescription("Can't be approved yet: this team needs at least 3 people.");
    await expect(teams.getByText("Can't be approved yet: this team needs at least 3 people.")).toBeVisible();
    await approve.focus();
    await expect(approve).toBeFocused();
    await page.keyboard.press("Enter");
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).status).toBe("PENDING_APPROVAL");

    await prisma.event.update({ where: { id: approvalEventId }, data: { teamMinSize: null } });
    await page.reload();
    await page.getByRole("tab", { name: /^Teams/ }).click();
    await expect(teams.getByText(approvalTeamName)).toBeVisible();
    await expect(approve).not.toHaveAttribute("aria-disabled");
    await approve.click();
    await expect
      .poll(async () => (await prisma.rSVP.findMany({ where: { eventId: approvalEventId }, select: { status: true } })).map((rsvp) => rsvp.status))
      .toEqual(["CONFIRMED", "CONFIRMED"]);
    expect((await prisma.team.findUniqueOrThrow({ where: { id: team.id } })).status).toBe("CONFIRMED");
    await discardQueuedTestEmail();
    expect(errors).toEqual([]);
    await context.close();

    const tickets = await prisma.rSVP.findMany({ where: { eventId: approvalEventId }, select: { checkInToken: true, guestName: true } });
    for (const ticket of tickets) {
      const ticketPage = await memberContext.newPage();
      await ticketPage.goto(`/ticket/${ticket.checkInToken}`);
      const card = ticketPage.locator("section", { has: ticketPage.locator("#ticket-team-title") });
      await expect(card.getByRole("heading", { level: 2, name: approvalTeamName }), ticket.guestName ?? "").toBeVisible();
      await expect(card.getByText(/^Led by /)).toBeVisible();
      const members = card.getByRole("list", { name: "Team members" }).getByRole("listitem");
      await expect(members).toHaveCount(2);
      await ticketPage.close();
    }
    await leaderContext.close();
    await memberContext.close();
  });

  test("the check-in desk lookup says it matches teams and finds a team's members", async ({ browser }) => {
    const { context, page } = await ownerContext(browser);
    const errors = collectPageErrors(page);
    await page.goto(`/dashboard/${orgSlug}/event/${eventId}/check-in`);
    const search = page.getByRole("textbox", { name: "Name, email or team", exact: true });
    await expect(search).toHaveAttribute("placeholder", "Name, email or team");
    await waitForHydration(page, "#check-in-search");
    await search.fill(teamName);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByRole("button", { name: leader.name }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: member.name }).first()).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("the create event dialog explains a too-small team size inline and focuses the field", async ({ browser }) => {
    const { context, page } = await ownerContext(browser);
    const errors = collectPageErrors(page);
    await page.goto(`/dashboard/${orgSlug}`);
    await page.getByRole("button", { name: "New event" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Create Event: Basics" })).toBeVisible();
    await dialog.getByRole("textbox", { name: /^Title/ }).fill(`Too Small ${suffix}`);
    await dialog.getByRole("textbox", { name: "About the event" }).fill("Checks the team size message.");
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("heading", { name: "Create Event: Schedule" })).toBeVisible();
    await dialog.getByRole("button", { name: "Next" }).click();
    await expect(dialog.getByRole("heading", { name: "Create Event: Location" })).toBeVisible();
    await dialog.getByRole("textbox", { name: /^Location/ }).fill("Community Hall, 1 Test Street");
    await dialog.getByRole("switch", { name: /^Team registration/ }).click();
    const largest = dialog.getByRole("spinbutton", { name: "Largest team" });
    await largest.fill("1");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    const message = "Teams need room for at least 2 people.";
    await expect(dialog.getByText(message)).toBeVisible();
    await expect(dialog.getByText(message)).toHaveAttribute("aria-live", "polite");
    await expect(largest).toBeFocused();
    await expect(largest).toHaveAttribute("aria-invalid", "true");
    await expect(largest).toHaveAccessibleDescription(message);
    // No native constraint competes with the inline message (no browser bubble).
    expect(await largest.evaluate((node: HTMLInputElement) => node.validity.valid)).toBe(true);
    // Only the inline message: no second copy in the dialog's alert.
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(await prisma.event.count({ where: { organisationId, title: `Too Small ${suffix}` } })).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });
}
