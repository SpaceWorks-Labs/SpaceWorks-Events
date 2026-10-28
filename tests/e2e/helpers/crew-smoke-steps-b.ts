import { EventPageSectionType } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { prisma, orgSlug, eventSlug, asha, ashaEdited, ben, cleo, grace, nora, dashboard, newContext, ownerContext, hydrated, openCrewTab, crewList, crewRow, crewMemberByEmail, state } from "./crew-smoke";

// Steps 8–13: the People view, the sign-up link, the public section, the ticket page, the desk and removal. (docs/CREW.md)
export function crewSmokeLinkPageDeskTests() {
  test("8. Guests → People marks crew and offers no edit or remove for them", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await page.goto(`${dashboard()}?tab=guests&sub=people`);
    await hydrated(page.locator("#guest-search"));
    const guests = page.getByRole("list", { name: "Guests" });

    for (const name of [ashaEdited.name, grace.name]) {
      const row = guests.getByRole("listitem").filter({ hasText: name }).first();
      await expect(row.getByText("Crew", { exact: true })).toBeVisible();
      await hydrated(row.getByRole("button", { name: `More actions for ${name}` }));
      await row.getByRole("button", { name: `More actions for ${name}` }).click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitem", { name: "Copy ticket link" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "Remove RSVP" })).toHaveCount(0);
      await expect(menu.getByRole("menuitem", { name: /registration/ })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }

    const noraRow = guests.getByRole("listitem").filter({ hasText: nora.name }).first();
    await expect(noraRow.getByText("Crew", { exact: true })).toHaveCount(0);
    await noraRow.getByRole("button", { name: `More actions for ${nora.name}` }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "Edit registration or transfer ticket" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Remove RSVP" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    await context.close();
  });

  test("9. the sign-up link is created, replaced and turned off", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    const card = page.locator("section", { has: page.locator("#crew-link-title") });
    await expect(card.getByText("There is no sign-up link yet.")).toBeVisible();

    await card.getByRole("button", { name: "Create link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Crew sign-up link created" })).toBeVisible();
    const linkInput = card.getByRole("textbox", { name: "Sign-up link" });
    await expect(linkInput).toHaveValue(/\/crew\/[A-Za-z0-9_-]{43}$/);
    const first = (await prisma.eventCrewJoinLink.findUniqueOrThrow({ where: { eventId: state.eventId }, select: { token: true } })).token;
    await expect(linkInput).toHaveValue(new RegExp(`/crew/${first}$`));
    expect((await context.request.get(`/crew/${first}`)).status()).toBe(200);

    await card.getByRole("button", { name: "Replace link" }).click();
    const replace = page.getByRole("alertdialog", { name: "Replace the crew sign-up link?" });
    await replace.getByRole("button", { name: "Replace link" }).click();
    await expect(page.getByRole("status").filter({ hasText: "New crew sign-up link created" })).toBeVisible();
    await expect.poll(async () => (await prisma.eventCrewJoinLink.findUnique({ where: { eventId: state.eventId }, select: { token: true } }))?.token).not.toBe(first);
    const second = (await prisma.eventCrewJoinLink.findUniqueOrThrow({ where: { eventId: state.eventId }, select: { token: true } })).token;
    await expect(linkInput).toHaveValue(new RegExp(`/crew/${second}$`));
    expect((await context.request.get(`/crew/${first}`)).status()).toBe(404);
    expect((await context.request.get(`/crew/${second}`)).status()).toBe(200);

    await card.getByRole("button", { name: "Turn off" }).click();
    const turnOff = page.getByRole("alertdialog", { name: "Turn off the crew sign-up link?" });
    await turnOff.getByRole("button", { name: "Turn off" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Crew sign-up link turned off" })).toBeVisible();
    await expect(linkInput).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Create link" })).toBeVisible();
    await expect.poll(() => prisma.eventCrewJoinLink.count({ where: { eventId: state.eventId } })).toBe(0);
    expect((await context.request.get(`/crew/${second}`)).status()).toBe(404);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("10. switching on the Crew section publishes the shown members only", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await page.goto(`${dashboard()}?tab=page&sub=page`);
    const sections = page.locator("section", { has: page.locator("#event-page-sections-title") });
    const rows = sections.getByRole("listitem");
    await expect(rows.last()).toContainText("Crew");
    await expect(rows.last()).toContainText("3 crew shown");
    const crewSwitch = sections.getByRole("switch", { name: "Show Crew on the event page" });
    await expect(crewSwitch).not.toBeChecked();
    await hydrated(crewSwitch);

    await crewSwitch.click();
    await expect(crewSwitch).toBeChecked();
    const bar = page.getByRole("region", { name: "Unsaved changes" });
    await expect(bar).toContainText("1 unsaved change");
    await bar.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Event page saved" })).toBeVisible();
    await expect
      .poll(async () => (await prisma.eventPageSection.findUnique({ where: { pageId_type: { pageId: state.eventPageId, type: EventPageSectionType.CREW } }, select: { isVisible: true } }))?.isVisible)
      .toBe(true);

    const publicContext = await newContext(browser);
    const publicPage = await publicContext.newPage();
    publicPage.on("pageerror", (error) => errors.push(error.message));
    await publicPage.goto(`/${orgSlug}/${eventSlug}`);
    const section = publicPage.locator("section#crew");
    await expect(section.getByRole("heading", { level: 2, name: "Crew", exact: true })).toBeVisible();
    // The avatar repeats the name for screen readers, so match the visible card text.
    for (const name of [ashaEdited.name, cleo.name, ben.name]) {
      await expect(section.getByRole("paragraph").filter({ hasText: name })).toBeVisible();
    }
    await expect(section.getByText(ashaEdited.role, { exact: true })).toBeVisible();
    await expect(section.getByText(asha.bio, { exact: true })).toBeVisible();
    await expect(section).not.toContainText(grace.name);
    // Cards follow the organiser's order.
    const cards = await section.getByRole("listitem").allTextContents();
    expect(cards.map((text) => [ashaEdited.name, cleo.name, ben.name].find((name) => text.includes(name)))).toEqual([ashaEdited.name, cleo.name, ben.name]);
    await publicContext.close();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("10b. Guests → Crew warns when shown crew are hidden by the section switch, and turns it on", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await prisma.eventPageSection.updateMany({ where: { type: "CREW", page: { eventId: state.eventId } }, data: { isVisible: false } });
    await openCrewTab(page);
    const warning = page.getByRole("status").filter({ hasText: "The Crew section is off on your event page" });
    await expect(warning).toBeVisible();
    const turnOn = warning.getByRole("button", { name: "Turn on Crew section" });
    await hydrated(turnOn);
    await turnOn.click();
    await expect(page.getByRole("status").filter({ hasText: "The Crew section is on." })).toBeVisible();
    await expect(warning).toHaveCount(0);
    await expect.poll(async () => (await prisma.eventPageSection.findFirst({ where: { type: "CREW", page: { eventId: state.eventId } } }))?.isVisible).toBe(true);
    await page.goto(`/${orgSlug}/${eventSlug}`);
    await expect(page.locator("section#crew")).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("11. a crew ticket shows the Crew chip and no cancel control", async ({ browser }) => {
    const member = await crewMemberByEmail(ashaEdited.email);
    const { checkInToken } = await prisma.rSVP.findUniqueOrThrow({ where: { id: member!.rsvpId }, select: { checkInToken: true } });
    const context = await newContext(browser);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await page.goto(`/ticket/${checkInToken}`);
    await expect(page.getByText(new RegExp(`You.re on the crew, ${ashaEdited.name}!`))).toBeVisible();
    await expect(page.getByText("Crew", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Cancel registration/ })).toHaveCount(0);

    // An ordinary attendee's ticket still offers it.
    await page.goto(`/ticket/${state.noraRsvp.checkInToken}`);
    await expect(page.getByRole("button", { name: /Cancel registration/ })).toBeVisible();
    await expect(page.getByText("Crew", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("12. the check-in desk shows the crew badge and food preference", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    const member = await crewMemberByEmail(ashaEdited.email);
    await page.goto(`${dashboard()}/check-in`);
    await expect(page.getByRole("heading", { name: "Check-in desk" })).toBeVisible();
    const search = page.getByRole("textbox", { name: "Name or email", exact: true });
    await hydrated(search);
    await search.fill(ashaEdited.name);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: ashaEdited.name }).getByRole("button", { name: "Check in", exact: true }).first().click();

    const confirm = page.getByRole("dialog", { name: "Confirm check-in" });
    await expect(confirm).toContainText(ashaEdited.name);
    await expect(confirm.getByText("Crew", { exact: true })).toBeVisible();
    await expect(confirm).toContainText("Crew food preference:");
    await expect(confirm).toContainText(asha.food);
    await confirm.getByRole("button", { name: "Confirm" }).click();

    const result = page.getByRole("status").filter({ hasText: "Event crew" });
    await expect(result).toContainText("Checked in");
    await expect(result).toContainText(ashaEdited.name);
    await expect(result).toContainText("Crew food preference:");
    await expect(result).toContainText(asha.food);
    await expect.poll(async () => (await prisma.rSVP.findUniqueOrThrow({ where: { id: member!.rsvpId }, select: { checkedInAt: true } })).checkedInAt !== null).toBe(true);

    await openCrewTab(page);
    await expect(crewRow(page, ashaEdited.name).getByText("Checked in", { exact: true })).toBeVisible();
    await expect(crewRow(page, ben.name).getByText("Not checked in", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("13. removing a crew member deletes their ticket and check-in", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    const member = await crewMemberByEmail(ashaEdited.email);
    await openCrewTab(page);
    await crewRow(page, ashaEdited.name).getByRole("button", { name: `Remove ${ashaEdited.name} from the crew` }).click();
    const confirm = page.getByRole("alertdialog", { name: "Remove from the crew?" });
    await expect(confirm).toContainText(ashaEdited.name);
    await confirm.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${ashaEdited.name} removed from the crew` })).toBeVisible();
    await expect(crewRow(page, ashaEdited.name)).toHaveCount(0);
    await expect(crewList(page).getByRole("listitem")).toHaveCount(3);

    expect(await prisma.eventCrewMember.findUnique({ where: { id: member!.id } })).toBeNull();
    expect(await prisma.rSVP.findUnique({ where: { id: member!.rsvpId } })).toBeNull();
    // The converted attendee and the ordinary one are untouched.
    expect(await prisma.rSVP.count({ where: { id: { in: [state.graceRsvp.id, state.noraRsvp.id] } } })).toBe(2);
    expect(errors).toEqual([]);
    await context.close();
  });
}
