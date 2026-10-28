import { EventStatus } from "@prisma/client";
import { expect, test, type Locator } from "@playwright/test";
import { appOrigin } from "./helpers/client";
import {
  collectPageErrors,
  dashboard,
  discardQueuedTestEmail,
  eventId,
  eventSlug,
  judgeEmail,
  judgeId,
  manageTokens,
  newContext,
  orgSlug,
  outboxPayload,
  ownerEmail,
  type Payload,
  prisma,
  setUpJudgingSuite,
  solo,
  suffix,
  teams,
  userContext,
  waitForHydration,
} from "./helpers/judging";

// Hackathon judging journey (docs/HACKATHON.md): the organiser turns project
// submissions on, builds a rubric, two teams and a solo registrant submit, a
// JUDGE-only collaborator scores with the keyboard, and the organiser closes
// judging, picks a winner and publishes the results. One ordered story.
test.describe.configure({ mode: "serial", timeout: 120_000 });

setUpJudgingSuite();

test("the organiser turns submissions on in Settings and is pointed to the new Judging tab", async ({ browser }) => {
  const { context, page } = await userContext(browser, ownerEmail);
  const errors = collectPageErrors(page);
  // While the event is a draft, switching submissions on warns that entrants can't submit yet.
  await prisma.event.update({ where: { id: eventId }, data: { status: EventStatus.DRAFT } });
  await page.goto(`${dashboard()}?tab=settings`);
  await expect(page.getByRole("tab", { name: "Judging", exact: true })).toHaveCount(0);
  const card = page.locator("section", { has: page.getByRole("heading", { name: "Project submissions" }) });
  await waitForHydration(page, 'button[role="switch"]');
  // The embed snippets gain the absolute origin once hydrated, without a hydration mismatch.
  await expect(page.locator("details code, details pre").first()).toContainText(new URL(page.url()).origin);
  await expect(card.getByText("This event is still a draft.")).toHaveCount(0);
  await card.getByRole("switch", { name: /Projects and judging/ }).click();
  await expect(card.getByText("This event is still a draft.")).toBeVisible();
  await expect(card.getByText(/can't see the submission form, or submit, until you publish/)).toBeVisible();
  await prisma.event.update({ where: { id: eventId }, data: { status: EventStatus.PUBLISHED } });
  await card.getByLabel(/^Opens/).fill(new Date(Date.now() - 60 * 60_000).toISOString().slice(0, 16));
  await card.getByLabel(/^Closes/).fill(new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString().slice(0, 16));
  await card.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText(/Project submissions are on\. .*Judging tab/).first()).toBeVisible();
  await expect(page.getByRole("tab", { name: "Judging", exact: true })).toBeVisible();

  // Results before judging starts: the hint says to open judging first, not to close it.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-results`);
  await expect(page.getByText(/Judging hasn't started\. Open judging on the Setup tab/).filter({ visible: true })).toBeVisible();
  await expect(page.getByText("Close judging on the Setup tab before you publish results.")).toHaveCount(0);

  // The organiser's own Score tab speaks to them as the organiser and links to the rubric.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-score`);
  await waitForHydration(page, "button");
  await expect(page.getByText("The organisers have not added judging criteria")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit the rubric" }).click();
  await expect(page.getByRole("tab", { name: "Setup" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Add criterion" })).toBeVisible();

  // Judges: the invited JUDGE collaborator is listed apart from the organisers.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-judges`);
  const invited = page.locator("section", { has: page.getByRole("heading", { name: "Invited judges" }) });
  const organisers = page.locator("section", { has: page.getByRole("heading", { name: "Organisers who can also judge" }) });
  await expect(invited).toContainText("Jude Judge");
  await expect(invited).not.toContainText("Judging Owner");
  await expect(organisers).toContainText("Judging Owner");

  // The live event shows no draft warning.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-setup`);
  await waitForHydration(page, "button");
  await expect(page.getByText("This event is still a draft.")).toHaveCount(0);
  // Hackathon emails are opt-in: both switches start off.
  const hackathonEmails = page.getByRole("group", { name: "Hackathon emails" });
  await expect(hackathonEmails.getByRole("switch", { name: /Email entrants when results are published/ })).not.toBeChecked();
  await expect(hackathonEmails.getByRole("switch", { name: /Email a receipt when a project is submitted/ })).not.toBeChecked();
  for (const criterion of [
    { name: "Impact", weight: "2", max: "10" },
    { name: "Execution", weight: "1", max: "5" },
  ]) {
    await page.getByRole("button", { name: "Add criterion" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Name/).fill(criterion.name);
    await dialog.getByLabel(/^Weight/).fill(criterion.weight);
    await dialog.getByLabel(/^Maximum score/).fill(criterion.max);
    await dialog.getByRole("button", { name: "Add criterion" }).click();
    await expect(dialog).toHaveCount(0);
  }
  await expect.poll(() => prisma.judgingCriterion.count({ where: { eventId } })).toBe(2);
  expect(errors).toEqual([]);
  await context.close();
});

test("teams submit from their team page and a solo registrant through the emailed link", async ({ browser }) => {
  const context = await newContext(browser);
  for (const entry of Object.values(teams)) {
    const response = await context.request.post("/api/rsvp", {
      headers: { origin: appOrigin },
      data: { orgSlug, eventSlug, guestEmail: entry.leader.email, name: entry.leader.name, answers: {}, team: { mode: "create", name: entry.team } },
    });
    expect(response.status(), await response.text()).toBe(200);
    const team = await prisma.team.findFirstOrThrow({ where: { eventId, name: entry.team } });
    manageTokens[entry.team] = String((await outboxPayload("team-created", (payload) => payload.teamId === team.id)).manageToken);

    const page = await context.newPage();
    await page.goto(`/team/${manageTokens[entry.team]}`);
    const card = page.getByRole("region", { name: "Team project" });
    await waitForHydration(page, "form button");
    await card.getByLabel(/^Project title/).fill(entry.project);
    await card.getByLabel(/^Code repository/).fill("http://example.com/insecure");
    await card.getByRole("button", { name: "Submit project" }).click();
    await expect(card.getByText("Use a full https:// link")).toBeVisible();
    await card.getByLabel(/^Code repository/).fill("https://example.com/code");
    await card.getByRole("button", { name: "Submit project" }).click();
    // Receipts are off by default, so the confirmation promises no email.
    await expect(card.getByText("Project submitted. You can keep editing until submissions close.")).toBeVisible();
    await page.close();
  }

  const response = await context.request.post("/api/rsvp", { headers: { origin: appOrigin }, data: { orgSlug, eventSlug, guestEmail: solo.email, name: solo.name, answers: {}, team: { mode: "solo" } } });
  expect(response.status(), await response.text()).toBe(200);
  const rsvp = await prisma.rSVP.findFirstOrThrow({ where: { eventId, guestEmail: solo.email } });
  const ticket = await context.newPage();
  await ticket.goto(`/ticket/${rsvp.checkInToken}`);
  await waitForHydration(ticket, "section button");
  await ticket.getByRole("button", { name: "Email me my submission link" }).click();
  const token = String((await outboxPayload("submission-link", (payload) => payload.rsvpId === rsvp.id)).token);
  const page = await context.newPage();
  await page.goto(`/submit/${token}`);
  // The solo project page has the Space Works site chrome: a main landmark for the skip link.
  await expect(page.locator("main#main-content")).toContainText("Your project");
  await waitForHydration(page, "form button");
  await page.getByLabel(/^Project title/).fill(`Solo Project ${suffix}`);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText(/Draft saved/)).toBeVisible();
  expect(await prisma.submission.count({ where: { eventId, status: "SUBMITTED" } })).toBe(2);
  // Crawlers are kept off the solo submission link like the other capability links.
  expect(await (await context.request.get("/robots.txt")).text()).toContain("Disallow: /submit/");
  await discardQueuedTestEmail();
  await context.close();
});

test("a JUDGE-only collaborator scores with the keyboard; focus follows the scoring view", async ({ browser }) => {
  await prisma.event.update({ where: { id: eventId }, data: { judgingStatus: "OPEN" } });
  const { context, page } = await userContext(browser, judgeEmail);
  const errors = collectPageErrors(page);
  await page.goto(`${dashboard()}?tab=guests`);
  await expect(page.getByRole("heading", { name: "Score submissions" })).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(await page.content()).not.toContain(teams.alpha.leader.email);
  await waitForHydration(page, "li button");

  const scores = { [teams.alpha.project]: { Impact: 8, Execution: 4 }, [teams.beta.project]: { Impact: 5, Execution: 5 } };
  async function scoreAndSubmit(project: string) {
    for (const [criterion, score] of Object.entries(scores[project]!)) {
      const max = criterion === "Impact" ? 10 : 5;
      await page.getByRole("group", { name: criterion, exact: true }).getByRole("radio", { name: `${score} out of ${max}` }).check({ force: true });
    }
    await page.getByLabel(/^Private comment/).fill(`Private note on ${project}`);
    await page.getByRole("button", { name: "Submit review" }).click();
  }

  // "Score next project" picks on the server: neither project has a review, so the older one (Alpha) first.
  await page.getByRole("button", { name: "Score next project" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: teams.alpha.project })).toBeFocused();
  await scoreAndSubmit(teams.alpha.project);
  // Submitting moves on to the next project, with a toast and focus on its heading.
  await expect(page.getByText(`Next up: “${teams.beta.project}” (this is the last one)`)).toBeVisible();
  await expect(page.getByRole("heading", { name: teams.beta.project })).toBeFocused();
  // The way back to the list returns focus to that project's row.
  await page.getByRole("button", { name: "All submissions" }).click();
  await expect(page.getByRole("button", { name: new RegExp(teams.beta.project) })).toBeFocused();

  // Opening from the list still works with the keyboard; the last review ends in the done state.
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: teams.beta.project })).toBeFocused();
  await scoreAndSubmit(teams.beta.project);
  await expect(page.getByRole("heading", { name: "You're all caught up" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Score next project" })).toHaveCount(0);
  await expect.poll(() => prisma.judgeReview.count({ where: { judgeUserId: judgeId, submittedAt: { not: null } } })).toBe(2);
  expect(errors).toEqual([]);
  await context.close();
});

test("the organiser closes judging, ranks, awards and publishes once", async ({ browser }) => {
  const { context, page } = await userContext(browser, ownerEmail);
  await page.goto(`${dashboard()}?tab=judging&sub=judging-setup`);
  await waitForHydration(page, "button");
  await page.getByRole("button", { name: /^Close judging/ }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: /^Close judging$/ }).click();
  await expect.poll(async () => (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).judgingStatus).toBe("CLOSED");

  await page.goto(`${dashboard()}?tab=judging&sub=judging-results`);
  const rows = page.getByRole("region", { name: "Ranked projects" }).getByRole("row");
  await expect(rows.nth(1)).toContainText(teams.alpha.project);
  await expect(rows.nth(1)).toContainText("80.0");
  await expect(rows.nth(2)).toContainText("66.7");

  // "Adjust for harsh/generous judges": both scores stay in the table. One judge
  // with two reviews (fewer than 3) keeps raw scores, so the ranking is unchanged.
  await waitForHydration(page, "button");
  const adjust = page.getByRole("switch", { name: /Adjust for harsh\/generous judges/ });
  await expect(adjust).not.toBeChecked();
  await expect(page.getByRole("columnheader", { name: /Adjusted/ })).toBeVisible();
  await adjust.click();
  await expect.poll(async () => (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).scoreNormalization).toBe("ZSCORE");
  await expect(adjust).toBeChecked();
  await expect(page.getByText(/Ranked by the adjusted score/)).toBeVisible();
  await expect(rows.nth(1)).toContainText(teams.alpha.project);
  await adjust.click();
  await expect.poll(async () => (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).scoreNormalization).toBe("RAW");

  await page.goto(`${dashboard()}?tab=judging&sub=judging-awards`);
  await waitForHydration(page, "button");
  await page.getByRole("button", { name: "Add award" }).click();
  await page.getByRole("dialog").getByLabel(/^Name/).fill("Overall winner");
  await page.getByRole("dialog").getByRole("button", { name: "Add award" }).click();
  await page.getByRole("button", { name: "Pick a winner" }).click();
  const picker = page.getByRole("dialog", { name: "Pick a winner" });
  // The picker searches the ranking on the server and preselects the top-ranked project.
  await expect(picker.getByRole("radio", { name: new RegExp(teams.alpha.project) })).toBeChecked();
  await picker.getByRole("button", { name: "Save winner" }).click();
  await expect.poll(() => prisma.eventAwardWinner.count({ where: { award: { eventId } } })).toBe(1);

  const publish = async (emailCopy: RegExp) => {
    await page.getByRole("button", { name: /^Publish results/ }).click();
    const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dialog.getByText(emailCopy)).toBeVisible();
    await dialog.getByRole("button", { name: /^Publish results$/ }).click();
    await expect.poll(async () => Boolean((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).resultsPublishedAt)).toBe(true);
  };
  const recipients = async () =>
    (await prisma.outboxMessage.findMany({ where: { kind: "results-published", payload: { path: ["eventId"], equals: eventId } }, select: { payload: true } })).map((row) => String((row.payload as Payload).to));
  // Receipts were off, so no project got a submission-received email.
  const projects = (await prisma.submission.findMany({ where: { eventId }, select: { id: true } })).map((row) => ({ payload: { path: ["submissionId"], equals: row.id } }));
  expect(await prisma.outboxMessage.count({ where: { kind: "submission-received", OR: projects } })).toBe(0);
  await page.goto(`${dashboard()}?tab=judging&sub=judging-results`);
  await waitForHydration(page, "button");
  // The results email is off by default: publishing says so and queues nothing.
  await expect(page.getByText("Publishing won't email entrants. You can turn that on in Judging → Setup.")).toBeVisible();
  await publish(/Results will be published without emailing entrants\./);
  await expect(page.getByText(/Entrants weren't emailed\./)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send results email now/ })).toHaveCount(0);
  expect(await recipients()).toEqual([]);
  expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).resultsAnnouncedAt).toBeNull();

  // Turning the switch on afterwards offers "Send results email now", which emails each entrant once.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-setup`);
  await waitForHydration(page, 'button[role="switch"]');
  await page.getByRole("group", { name: "Hackathon emails" }).getByRole("switch", { name: /Email entrants when results are published/ }).click();
  await expect(page.getByText(/Results are already published\. After saving, send the email from the Results tab/)).toBeVisible();
  await page.locator("section", { has: page.getByRole("heading", { name: "Project submissions" }) }).getByRole("button", { name: "Save settings" }).click();
  await expect.poll(async () => (await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).emailEntrantsOnResults).toBe(true);
  expect(await recipients()).toEqual([]);
  await page.goto(`${dashboard()}?tab=judging&sub=judging-results`);
  await waitForHydration(page, "button");
  await expect(page.getByText("Entrants haven't been emailed yet.")).toBeVisible();
  await page.getByRole("button", { name: /^Send results email now/ }).click();
  const sendDialog = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(sendDialog.getByText(/3 entrants will be emailed that the results are out\./)).toBeVisible();
  await expect(sendDialog.getByText(/sending limits/)).toBeVisible();
  await sendDialog.getByRole("button", { name: /^Send results email$/ }).click();
  await expect.poll(async () => (await recipients()).sort()).toEqual([teams.alpha.leader.email, teams.beta.leader.email, solo.email].sort());
  await expect(page.getByText("Entrants were emailed that the results are out.")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Send results email now/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Unpublish/ }).click();
  await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: /^Unpublish$/ }).click();
  await expect.poll(async () => Boolean((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).resultsPublishedAt)).toBe(false);
  // Republishing with the switch on emails only those whose copy the unpublish withdrew, never anyone twice.
  await publish(/will be emailed/);
  const again = await recipients();
  expect(new Set(again).size).toBe(again.length);

  // Disqualifying a winner after publication spells out the change to the live results page.
  await page.goto(`${dashboard()}?tab=judging&sub=judging-submissions`);
  await waitForHydration(page, "button");
  await page.getByRole("button", { name: `Actions for ${teams.alpha.project}` }).click();
  await page.getByRole("menuitem", { name: /^Disqualify/ }).click();
  const disqualify = page.getByRole("alertdialog");
  await expect(disqualify.getByText("The live results page will change")).toBeVisible();
  await expect(disqualify.getByText("Overall winner (1st place)").first()).toBeVisible();
  await expect(disqualify.getByText(/live results page changes straight away/)).toBeVisible();
  await disqualify.getByRole("button", { name: "Cancel" }).click();
  await expect(disqualify).toHaveCount(0);
  expect(await prisma.submission.count({ where: { eventId, status: "DISQUALIFIED" } })).toBe(0);
  // A project with no award: disqualify, then reinstating says lost awards don't come back.
  await page.getByRole("button", { name: `Actions for ${teams.beta.project}` }).click();
  await page.getByRole("menuitem", { name: /^Disqualify/ }).click();
  await expect(page.getByRole("alertdialog").getByText(/holds no award, so the live results page doesn't change/)).toBeVisible();
  await page.getByRole("alertdialog").getByLabel(/^Reason/).fill("Late entry");
  await page.getByRole("alertdialog").getByRole("button", { name: "Disqualify", exact: true }).click();
  await expect.poll(() => prisma.submission.count({ where: { eventId, status: "DISQUALIFIED" } })).toBe(1);
  await page.getByRole("button", { name: `Actions for ${teams.beta.project}` }).click();
  await page.getByRole("menuitem", { name: /^Reinstate/ }).click();
  const reinstate = page.getByRole("alertdialog").or(page.getByRole("dialog"));
  await expect(reinstate.getByText(/Awards it lost when it was disqualified aren't given back/)).toBeVisible();
  await reinstate.getByRole("button", { name: "Reinstate", exact: true }).click();
  await expect.poll(() => prisma.submission.count({ where: { eventId, status: "DISQUALIFIED" } })).toBe(0);

  const anon = await newContext(browser);
  const results = await anon.newPage();
  await results.goto(`/${orgSlug}/${eventSlug}/results`);
  await expect(results.getByText("Overall winner")).toBeVisible();
  await expect(results.getByText(teams.alpha.project)).toBeVisible();
  const html = await results.content();
  for (const forbidden of ["80.0", "66.7", "Private note", teams.alpha.leader.email]) expect(html).not.toContain(forbidden);
  await anon.close();
  await discardQueuedTestEmail();
  await context.close();
});

/** The tab lies fully inside its scrolling row, horizontally (the row's scroll position was set to show it). */
async function expectScrolledIntoRow(tab: Locator) {
  await expect.poll(() => tab.evaluate((node) => {
    const row = node.closest('[role="tablist"]')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return box.left >= row.left - 1 && box.right <= row.right + 1 && box.right <= window.innerWidth;
  })).toBe(true);
}

test("on a phone the active tab and sub-tab are scrolled into view", async ({ browser }) => {
  const { context, page } = await userContext(browser, ownerEmail);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${dashboard()}?tab=judging&sub=judging-awards`);
  await waitForHydration(page, '[role="tab"]');
  const mainTab = page.getByRole("tablist", { name: "Manage event" }).getByRole("tab", { name: "Judging", exact: true });
  const subTab = page.getByRole("tablist", { name: "Judging sections" }).getByRole("tab", { name: /^Awards/ });
  await expect(mainTab).toHaveAttribute("aria-selected", "true");
  await expect(subTab).toHaveAttribute("aria-selected", "true");
  // Both rows overflow at this width, so the active tabs had to be scrolled to.
  expect(await page.getByRole("tablist", { name: "Manage event" }).evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  // Horizontal only: the rows sit low on a phone (TEAM events add a detail
  // line to the header stats), so vertical position is not what's tested.
  await expectScrolledIntoRow(mainTab);
  await expectScrolledIntoRow(subTab);
  // The last main tab, deep-linked, is brought into view as well.
  await page.goto(`${dashboard()}?tab=settings`);
  await waitForHydration(page, '[role="tab"]');
  await expectScrolledIntoRow(page.getByRole("tablist", { name: "Manage event" }).getByRole("tab", { name: "Settings", exact: true }));
  await context.close();
});
