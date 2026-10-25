import { EventPrivacyType, EventStatus, RegistrationMode } from "@prisma/client";
import { expect, test } from "@playwright/test";
import {
  collectPageErrors,
  discardQueuedTestEmail,
  eventId,
  eventSlug,
  eventTitle,
  expectCapabilityHeaders,
  leader,
  member,
  newContext,
  orgSlug,
  ownerContext,
  prisma,
  setUpTeamsSuite,
  soloEntrant,
  teamName,
  waitForHydration,
} from "./helpers/teams";
import { teamsApprovalTests } from "./helpers/teams-approval";
import { teamsMatchingTests } from "./helpers/teams-matching";

// Team registration journeys (docs/TEAMS.md). One ordered story: the organiser
// turns team mode on, a leader creates a team through the public form, a
// teammate joins through the join link, and an organiser approves a team on an
// approval-required event. The generous timeout covers first-visit route
// compilation on a cold dev server.
test.describe.configure({ mode: "serial", timeout: 120_000 });

let manageToken = "";
let joinPath = "";

setUpTeamsSuite();

test("an organiser turns on team registration in the event's publishing settings", async ({ browser }) => {
  const { context, page } = await ownerContext(browser);
  const errors = collectPageErrors(page);
  await page.goto(`/dashboard/${orgSlug}/event/${eventId}?tab=page`);
  const form = page.getByRole("form", { name: "Event details" });
  await expect(form).toBeVisible();
  const teamSwitch = form.getByRole("switch", { name: /^Team registration/ });
  await waitForHydration(page, 'form[aria-label="Event details"] [role="switch"]');
  await expect(teamSwitch).not.toBeChecked();
  await teamSwitch.click();
  await expect(teamSwitch).toBeChecked();
  await form.getByRole("spinbutton", { name: "Smallest team" }).fill("2");
  await form.getByRole("spinbutton", { name: "Largest team" }).fill("3");
  // The solo-policy dropdown is named by its question (not by the hidden native select).
  await expect(form.getByRole("combobox", { name: "Can people sign up without a team?" })).toHaveText("Teams or on their own");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Event saved").first()).toBeVisible();
  await expect
    .poll(async () => prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { registrationMode: true, teamMinSize: true, teamMaxSize: true } }))
    .toEqual({ registrationMode: RegistrationMode.TEAM, teamMinSize: 2, teamMaxSize: 3 });
  expect(errors).toEqual([]);
  await context.close();
});

test("a leader creates a team through the public form and sees the confirmation", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await page.goto(`/${orgSlug}/${eventSlug}`);
  const joinCard = page.locator("section", { has: page.locator("#join-title") });
  await expect(joinCard.getByText("0 places taken")).toBeVisible();
  await page.getByRole("button", { name: /^Register/ }).first().click();
  const dialog = page.getByRole("dialog", { name: `Register for ${eventTitle}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Create a team/ })).toBeChecked();
  // Keyboard: the arrow keys move through the options without focus leaving the group,
  // including through "Join with a link", which hides the rest of the form.
  await waitForHydration(page, '[role="dialog"] [role="radio"]');
  await dialog.getByRole("radio", { name: /Create a team/ }).focus();
  // Radix moves focus a tick after keydown and checks the option only while the
  // key is still down, so hold each key briefly as a person does.
  const pressArrow = async (key: "ArrowDown" | "ArrowUp") => {
    await page.keyboard.down(key);
    await page.waitForTimeout(100);
    await page.keyboard.up(key);
  };
  await pressArrow("ArrowDown");
  await expect(dialog.getByRole("radio", { name: /Join with a link/ })).toBeFocused();
  await expect(dialog.getByRole("radio", { name: /Join with a link/ })).toBeChecked();
  // The note says what the link does, with the callout's own icon only.
  const linkNote = dialog.locator("div.rounded-lg", { hasText: "Ask your team leader for the team link" }).last();
  await expect(linkNote).toContainText("The link opens a page for that team where you register straight into it.");
  await expect(linkNote).not.toContainText("brings you back");
  await expect(linkNote.locator("svg")).toHaveCount(1);
  await pressArrow("ArrowUp");
  await expect(dialog.getByRole("radio", { name: /Create a team/ })).toBeFocused();
  await expect(dialog.getByRole("radio", { name: /Create a team/ })).toBeChecked();
  await dialog.getByRole("textbox", { name: /^Team name/ }).fill(teamName);
  await dialog.getByRole("textbox", { name: /^Name/ }).fill(leader.name);
  await dialog.getByRole("textbox", { name: /^Email/ }).fill(leader.email);
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  // A new leader's dialog stays open on the done message: the team page link is emailed.
  await expect(dialog.getByText(/Your team is registered\. Check your email for your team page link/)).toBeVisible();
  // The places count behind the dialog updates without a reload.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(joinCard.getByText("1 place taken")).toBeVisible();

  const team = await prisma.team.findFirstOrThrow({ where: { eventId }, include: { members: true } });
  expect(team.name).toBe(teamName);
  expect(team.status).toBe("CONFIRMED");
  expect(team.members.map((rsvp) => rsvp.guestEmail)).toEqual([leader.email]);
  expect(team.leaderRsvpId).toBe(team.members[0]!.id);

  // The raw management token exists only in the queued team-created email.
  const created = await prisma.outboxMessage.findMany({ where: { kind: "team-created" }, select: { payload: true } });
  const payload = created.map((message) => message.payload as { to?: string; teamId?: string; manageToken?: string }).find((item) => item.teamId === team.id);
  expect(payload?.to).toBe(leader.email);
  manageToken = payload!.manageToken!;
  expect(manageToken).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
  await discardQueuedTestEmail();
  expect(errors).toEqual([]);
  await context.close();
});

test("the team page shows the join link and is a private, unindexed page", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await expectCapabilityHeaders(await page.request.get(`/team/${manageToken}`), "/team/:token");

  await page.goto(`/team/${manageToken}`);
  // The page sits in the Space Works site chrome: header, a main landmark (skip-link target) and the page gutter.
  const main = page.locator("main#main-content");
  await expect(main).toBeVisible();
  const joinCard = main.locator("section", { has: page.locator("#team-join-link") });
  await expect(joinCard).toBeVisible();
  const joinUrl = (await joinCard.locator(".font-mono").innerText()).trim();
  joinPath = new URL(joinUrl, "http://placeholder.invalid").pathname;
  expect(joinPath).toMatch(new RegExp(`^/${orgSlug}/${eventSlug}/team/[A-Za-z0-9_-]{32,128}$`));
  await expect(page.getByRole("list").filter({ hasText: leader.name }).first()).toBeVisible();
  // A confirmed team below the minimum on an event without approval is told to grow, not that approval waits.
  await expect(main.getByText("Teams need at least 2 members. Add 1 more with the join link so your team is complete.")).toBeVisible();
  await expect(main.getByText(/can't approve your team/)).toHaveCount(0);

  // An unknown management token reveals nothing.
  expect((await page.request.get(`/team/${"x".repeat(43)}`)).status()).toBe(404);
  expect(errors).toEqual([]);
  await context.close();
});

test("a second person joins the team through the join link", async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await expectCapabilityHeaders(await page.request.get(joinPath), "join page");

  await page.goto(joinPath);
  await expect(page.getByRole("heading", { level: 2, name: `Join ${teamName}` })).toBeVisible();
  // The join page shows the team's name and size, never its members.
  await expect(page.getByText("1 of 3 members")).toBeVisible();
  await expect(page.getByText(leader.name)).toHaveCount(0);
  await waitForHydration(page, 'input[name="name"], input[autocomplete="name"]');
  await page.getByRole("textbox", { name: /^Name/ }).fill(member.name);
  await page.getByRole("textbox", { name: /^Email/ }).fill(member.email);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(`You’re on ${teamName}.`, { exact: false })).toBeVisible();

  const rsvps = await prisma.rSVP.findMany({ where: { eventId }, select: { guestEmail: true, status: true, team: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  expect(rsvps).toEqual([
    { guestEmail: leader.email, status: "CONFIRMED", team: { name: teamName } },
    { guestEmail: member.email, status: "CONFIRMED", team: { name: teamName } },
  ]);
  await discardQueuedTestEmail();
  expect(errors).toEqual([]);
  await context.close();
});

test("the join link 404s for hidden, invite-only and unreleased events", async ({ browser }) => {
  const context = await newContext(browser);
  const cases: Array<{ label: string; status?: EventStatus; privacyType?: EventPrivacyType; released?: boolean }> = [
    { label: "hidden", status: EventStatus.HIDDEN },
    { label: "draft", status: EventStatus.DRAFT },
    { label: "invite-only", privacyType: EventPrivacyType.INVITE_ONLY },
    { label: "unreleased website", released: false },
  ];
  try {
    for (const item of cases) {
      await prisma.event.update({
        where: { id: eventId },
        data: { status: item.status ?? EventStatus.PUBLISHED, privacyType: item.privacyType ?? EventPrivacyType.PUBLIC },
      });
      await prisma.eventPage.update({ where: { eventId }, data: { isPublished: item.released ?? true } });
      const response = await context.request.get(joinPath);
      expect(response.status(), item.label).toBe(404);
      expect(await response.text(), item.label).not.toContain(teamName);
    }
  } finally {
    await prisma.event.update({ where: { id: eventId }, data: { status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC } });
    await prisma.eventPage.update({ where: { eventId }, data: { isPublished: true } });
  }
  // Released again, the same link works; a retired or unknown token never does.
  expect((await context.request.get(joinPath)).status()).toBe(200);
  expect((await context.request.get(`/${orgSlug}/${eventSlug}/team/${"y".repeat(43)}`)).status()).toBe(404);
  await context.close();
});

test("a solo registrant joins the team by pasting its link on their ticket page", async ({ browser }) => {
  const context = await newContext(browser);
  const created = await context.request.post("/api/rsvp", {
    data: { orgSlug, eventSlug, guestEmail: soloEntrant.email, name: soloEntrant.name, answers: {}, team: { mode: "solo" } },
  });
  expect(created.status(), await created.text()).toBe(200);
  await discardQueuedTestEmail();
  const solo = await prisma.rSVP.findFirstOrThrow({ where: { eventId, guestEmail: soloEntrant.email }, select: { id: true, teamId: true, checkInToken: true } });
  expect(solo.teamId).toBeNull();

  const page = await context.newPage();
  const errors = collectPageErrors(page);
  // The ticket page (with Join a team and the seeker list) is a bearer page like /team/:token.
  await expectCapabilityHeaders(await page.request.get(`/ticket/${solo.checkInToken}`), "/ticket/:token");
  await page.goto(`/ticket/${solo.checkInToken}`);
  const card = page.locator("section", { has: page.locator("#ticket-join-team-title") });
  await expect(card).toBeVisible();
  await waitForHydration(page, 'section:has(#ticket-join-team-title) input');
  // A management link is not a join link and is refused.
  await card.getByRole("textbox", { name: /^Team link/ }).fill(`https://events.example/team/${manageToken}`);
  await card.getByRole("button", { name: "Join this team" }).click();
  await expect(card.getByText(/Paste the full team link/)).toBeVisible();
  // The join link, pasted without its scheme, moves this registration in.
  await card.getByRole("textbox", { name: /^Team link/ }).fill(`events.example${joinPath}`);
  await card.getByRole("button", { name: "Join this team" }).click();
  await expect(page.getByRole("heading", { level: 2, name: teamName })).toBeVisible();

  const moved = await prisma.rSVP.findUniqueOrThrow({ where: { id: solo.id }, select: { status: true, checkInToken: true, team: { select: { name: true } } } });
  expect(moved).toEqual({ status: "CONFIRMED", checkInToken: solo.checkInToken, team: { name: teamName } });
  expect(await prisma.rSVP.count({ where: { eventId } })).toBe(3);
  // The team is now full (3 of 3): the join page says so and doesn't promise a form.
  const fullJoin = await context.newPage();
  await fullJoin.goto(joinPath);
  await expect(fullJoin.getByText("This team is full")).toBeVisible();
  await expect(fullJoin.getByText(/Register below/)).toHaveCount(0);
  await fullJoin.close();
  await discardQueuedTestEmail();
  expect(errors).toEqual([]);
  await context.close();
});

// The tests run in this order and build on each other: the public event above, then approval, then matching.
teamsApprovalTests();
teamsMatchingTests();
