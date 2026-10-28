import { expect, test } from "@playwright/test";
import { JudgingStatus, OfflinePaymentMethod, PrismaClient, ScoreNormalization } from "@prisma/client";
import { CURRENCY, DAY, EMAILS, ORG_SLUG, inr } from "../seed/common";
import { anonymousPage, eventDashboard, open, userPage } from "./browser";
import { capture, card, heading, innerTabPanel, openTab } from "./shots";
import { seed } from "./state";

/* Hackathon judging while open, then results, prize payouts (one reversed) and the public results page. */

test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });

const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

test("hackathon judging while judging is open", async ({ browser }) => {
  const { context, page } = await userPage(browser, EMAILS.owner);

  await open(page, eventDashboard("hack", "?tab=judging"));
  await capture(page, "judging-setup", innerTabPanel(page));
  await capture(page, "judging-rubric", await card(heading(page, "Rubric").or(page.getByText("Rubric", { exact: true })).first()), { pad: 8 });

  await openTab(page, /^Submissions/);
  await capture(page, "judging-submissions", innerTabPanel(page));

  await openTab(page, /^Progress/);
  await capture(page, "judging-progress", [await card(page.getByText("Judging progress", { exact: true })), await card(page.getByText("Projects below target", { exact: true }))]);
  await context.close();

  // A judge (a JUDGE-only co-organiser) scores a project.
  const judge = await userPage(browser, EMAILS.judge);
  await open(judge.page, eventDashboard("hack"));
  await judge.page.getByRole("button", { name: /Cycle Safe/ }).click();
  const workspace = judge.page.locator("section").filter({ has: judge.page.locator("#judge-submission-title") });
  await expect(workspace).toBeVisible();
  for (const [criterion, score] of [["Impact", "8"], ["Technical execution", "7"]] as const) {
    await workspace.getByRole("group", { name: criterion }).getByRole("radio", { name: `${score} out of 10` }).check({ force: true });
  }
  await workspace.getByRole("textbox", { name: /Private comment/ }).fill("Strong idea with a clear path to the council. The demo needs a mobile layout.");
  await capture(judge.page, "judge-score-workspace", workspace, { maxHeight: 1500 });
  await judge.context.close();
});

test("hackathon results and prizes", async ({ browser }) => {
  // Close judging and pick winners as an organiser would.
  const hack = seed().events.hack;
  const awards = await prisma.eventAward.findMany({ where: { eventId: hack.id }, orderBy: { position: "asc" } });
  const byTitle = Object.fromEntries(seed().submissions.map((submission) => [submission.title, submission]));
  await prisma.eventAwardWinner.createMany({
    data: [
      { awardId: awards[0]!.id, submissionId: byTitle["FoodShare Finder"]!.id, place: 1 },
      { awardId: awards[1]!.id, submissionId: byTitle["Volunteer Rota"]!.id, place: 1 },
      { awardId: awards[2]!.id, submissionId: byTitle["Accessible Bus Times"]!.id, place: 1 },
    ],
  });
  await prisma.event.update({ where: { id: hack.id }, data: { judgingStatus: JudgingStatus.CLOSED, scoreNormalization: ScoreNormalization.ZSCORE } });

  const { context, page } = await userPage(browser, EMAILS.owner);
  await open(page, eventDashboard("hack", "?tab=judging&sub=judging-results"));
  await capture(page, "judging-results", innerTabPanel(page), { maxHeight: 1500 });

  // Prize money: one payout, one mistake reversed, then paid again correctly.
  const org = await prisma.organisation.findUniqueOrThrow({ where: { slug: ORG_SLUG } });
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: EMAILS.owner } });
  const now = Date.now();
  const payout = (award: (typeof awards)[number], title: string, amount: number, daysAgo: number, method: OfflinePaymentMethod, reference: string, reversesId?: string) =>
    prisma.prizePayout.create({
      data: {
        organisationId: org.id, eventId: hack.id, awardId: award.id, submissionId: byTitle[title]!.id, awardName: award.name, projectTitle: title,
        recipientName: byTitle[title]!.team, amountMinor: inr(amount), currency: CURRENCY, method, reference, paidAt: new Date(now - daysAgo * DAY),
        recordedByUserId: owner.id, reversesId, note: reversesId ? "Sent to the wrong account." : "",
      },
    });
  await payout(awards[0]!, "FoodShare Finder", 50000, 1, OfflinePaymentMethod.BANK_TRANSFER, "NEFT 5520");
  const mistake = await payout(awards[1]!, "Volunteer Rota", 25000, 1, OfflinePaymentMethod.UPI, "UPI 8812");
  await payout(awards[1]!, "Volunteer Rota", 25000, 0.5, OfflinePaymentMethod.UPI, "UPI 8812", mistake.id);
  await open(page, eventDashboard("hack", "?tab=judging&sub=judging-prizes"));
  await capture(page, "prize-payouts", innerTabPanel(page), { maxHeight: 1600 });
  await context.close();

  await prisma.event.update({ where: { id: hack.id }, data: { resultsPublishedAt: new Date(), resultsAnnouncedAt: new Date() } });
  const visitor = await anonymousPage(browser);
  await open(visitor.page, `/${ORG_SLUG}/${hack.slug}/results`);
  await capture(visitor.page, "public-results-page", visitor.page.locator("main"), { pad: 0, maxHeight: 1400 });
  await visitor.context.close();
});

