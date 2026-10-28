import { EventPrivacyType, RegistrationMode, RsvpStatus, SoloPolicy } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { appOrigin } from "./client";
import {
  collectPageErrors,
  createTeamEvent,
  declinedLeader,
  discardQueuedTestEmail,
  matchLeader,
  matchSeeker,
  matchSlug,
  matchTitle,
  newContext,
  orgSlug,
  ownerContext,
  prisma,
  suffix,
  waitForHydration,
} from "./teams";

/** Seeker matching on a leader's team page, a declined team, and team units on the dashboards. */
export function teamsMatchingTests() {
  test("a leader's team page lists invited seekers accurately and a declined team offers no management actions", async ({ browser }) => {
    const matchEvent = await createTeamEvent({ slug: matchSlug, title: matchTitle, privacyType: EventPrivacyType.PUBLIC });
    await prisma.event.update({ where: { id: matchEvent.id }, data: { registrationMode: RegistrationMode.TEAM, teamMaxSize: 4, soloPolicy: SoloPolicy.SOLO_WITH_MATCHING } });
    // One client address per registration, so the per-IP registration limit never couples them.
    const register = async (data: Record<string, unknown>) => {
      const registrant = await newContext(browser);
      const response = await registrant.request.post("/api/rsvp", { headers: { origin: appOrigin }, data });
      const result = { status: response.status(), text: await response.text() };
      await registrant.close();
      return result;
    };
    const created = await register({ orgSlug, eventSlug: matchSlug, guestEmail: matchLeader.email, name: matchLeader.name, answers: {}, team: { mode: "create", name: `Match Team ${suffix}` } });
    expect(created.status, created.text).toBe(200);
    const seeker = await register({
      orgSlug,
      eventSlug: matchSlug,
      guestEmail: matchSeeker.email,
      name: matchSeeker.name,
      answers: {},
      team: { mode: "solo", seeker: { headline: "Frontend developer", skills: ["React"] } },
    });
    expect(seeker.status, seeker.text).toBe(200);
    const declined = await register({ orgSlug, eventSlug: matchSlug, guestEmail: declinedLeader.email, name: declinedLeader.name, answers: {}, team: { mode: "create", name: `Declined Team ${suffix}` } });
    expect(declined.status, declined.text).toBe(200);
    const tokenFor = async (teamName: string) => {
      const team = await prisma.team.findFirstOrThrow({ where: { eventId: matchEvent.id, name: teamName } });
      const messages = await prisma.outboxMessage.findMany({ where: { kind: "team-created" }, select: { payload: true } });
      const payload = messages.map((message) => message.payload as { teamId?: string; manageToken?: string }).find((item) => item.teamId === team.id);
      return { team, manageToken: payload!.manageToken! };
    };
    const match = await tokenFor(`Match Team ${suffix}`);
    const rejected = await tokenFor(`Declined Team ${suffix}`);
    await discardQueuedTestEmail();

    const context = await newContext(browser);
    const page = await context.newPage();
    const errors = collectPageErrors(page);
    await page.goto(`/team/${match.manageToken}`);
    const matching = page.locator("section", { has: page.locator("#team-matching") });
    await expect(matching.locator("p", { hasText: "Sasha S." }).first()).toBeVisible();
    await waitForHydration(page, "section:has(#team-matching) button");
    await matching.getByRole("button", { name: "Invite Sasha S.", exact: true }).click();
    await expect(matching.getByRole("heading", { name: "Invitations you sent" })).toBeVisible();
    await expect(matching.getByText("Everyone looking for a team has already been invited. Check back later.")).toBeVisible();
    await expect(matching.getByText("No one is looking for a team yet")).toHaveCount(0);

    // A declined team: viewing and disbanding stay; rename and link resets are gone.
    await prisma.$transaction([
      prisma.team.update({ where: { id: rejected.team.id }, data: { status: RsvpStatus.REJECTED } }),
      prisma.rSVP.updateMany({ where: { teamId: rejected.team.id }, data: { status: RsvpStatus.REJECTED } }),
    ]);
    await page.goto(`/team/${rejected.manageToken}`);
    const main = page.locator("main#main-content");
    await expect(main.getByText(/The organisers declined this team/)).toBeVisible();
    await expect(main.getByRole("heading", { level: 1, name: `Declined Team ${suffix}` })).toBeVisible();
    await expect(main.getByRole("button", { name: "Rename" })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Reset management link/ })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Create a new link/ })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Disband team…" })).toBeVisible();
    await discardQueuedTestEmail();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("dashboards show team units against capacity and people separately; individual events are unchanged", async ({ browser }) => {
    // Three confirmed teams of two fill a capacity of 3 units with 6 people.
    const unitsEvent = await createTeamEvent({ slug: `units-${suffix}`, title: `Units Night ${suffix}`, privacyType: EventPrivacyType.PUBLIC });
    await prisma.event.update({ where: { id: unitsEvent.id }, data: { registrationMode: RegistrationMode.TEAM, teamMaxSize: 4, capacity: 3 } });
    for (const index of [1, 2, 3]) {
      const name = `Units Team ${index} ${suffix}`;
      const team = await prisma.team.create({
        data: { eventId: unitsEvent.id, name, nameKey: name.toLowerCase(), status: RsvpStatus.CONFIRMED, joinToken: `units-join-${index}-${suffix}`, manageTokenHash: `units-manage-${index}-${suffix}` },
      });
      for (const person of ["a", "b"]) {
        const email = `units-${index}${person}-${suffix}@example.test`;
        await prisma.rSVP.create({ data: { eventId: unitsEvent.id, guestEmail: email, guestName: `Units ${index}${person}`, attendeeKey: `guest:${email}`, status: RsvpStatus.CONFIRMED, teamId: team.id } });
      }
    }
    // An individual event keeps the plain "Going" people count.
    const individualSlug = `solo-night-${suffix}`;
    const individual = await createTeamEvent({ slug: individualSlug, title: `Solo Night ${suffix}`, privacyType: EventPrivacyType.PUBLIC });
    await prisma.event.update({ where: { id: individual.id }, data: { capacity: 5 } });
    for (const person of ["x", "y"]) {
      const email = `units-ind-${person}-${suffix}@example.test`;
      await prisma.rSVP.create({ data: { eventId: individual.id, guestEmail: email, guestName: `Ind ${person}`, attendeeKey: `guest:${email}`, status: RsvpStatus.CONFIRMED } });
    }

    const { context, page } = await ownerContext(browser);
    const errors = collectPageErrors(page);
    const headerStat = (label: string) => page.locator("header dl > div:visible", { has: page.locator("dt", { hasText: new RegExp(`^${label}$`) }) });

    await page.goto(`/dashboard/${orgSlug}/event/${unitsEvent.id}`);
    const places = headerStat("Places taken");
    await expect(places.locator("dd")).toContainText("3 / 3");
    await expect(places.locator("dd")).toContainText("teams & solo places · 6 people going");
    await expect(headerStat("Going")).toHaveCount(0);
    await expect(page.locator("header dl:visible").first()).not.toContainText("6 / 3");

    await page.goto(`/dashboard/${orgSlug}/event/${unitsEvent.id}?tab=analytics`);
    await expect(page.getByText("3 / 3 teams & solo places · full").filter({ visible: true }).first()).toBeVisible();
    await expect(page.getByText(/places left/)).toHaveCount(0);

    // The organisation event list chip compares units with capacity.
    await page.goto(`/dashboard/${orgSlug}`);
    await expect(page.getByRole("link", { name: new RegExp(`Units Night ${suffix}`) }).filter({ hasText: "Full", visible: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`Solo Night ${suffix}`) }).filter({ hasText: "2 / 5 going", visible: true }).first()).toBeVisible();

    await page.goto(`/dashboard/${orgSlug}/event/${individual.id}`);
    await expect(headerStat("Going").locator("dd")).toContainText("2 / 5");
    await expect(headerStat("Places taken")).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();

    // The public card already counts units: full, with no places left.
    const visitor = await newContext(browser);
    const publicPage = await visitor.newPage();
    await publicPage.goto(`/${orgSlug}/units-${suffix}`);
    const joinCard = publicPage.locator("section", { has: publicPage.locator("#join-title") });
    await expect(joinCard.getByText("3 places taken")).toBeVisible();
    await expect(joinCard.getByText("0 places left")).toBeVisible();
    await visitor.close();
  });
}
