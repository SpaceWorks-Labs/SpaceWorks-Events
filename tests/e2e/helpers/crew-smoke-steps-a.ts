import { RsvpStatus } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { prisma, suffix, asha, ashaEdited, ben, cleo, grace, dashboard, ownerContext, hydrated, discardQueuedTestEmail, openCrewTab, crewRow, crewRowNames, fillAddDialog, addMember, crewMemberByEmail, state } from "./crew-smoke";

// Steps 1–7: add, validate, edit, reorder, show/hide and convert a registration. (docs/CREW.md)
export function crewSmokeAddEditTests() {
  test("1. an organiser adds a crew member who gets a crew ticket and its email", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    await expect(page.getByText("No crew yet.")).toBeVisible();
    await addMember(page, asha);

    const row = crewRow(page, asha.name);
    await expect(row).toContainText(asha.role);
    await expect(row).toContainText(asha.email);
    await expect(row).toContainText(asha.food);
    await expect(row.getByText("Not checked in", { exact: true })).toBeVisible();
    await expect(row.getByRole("link", { name: `${asha.name} on LinkedIn (opens in a new tab)` })).toHaveAttribute("href", asha.linkedin);
    await expect(row.getByRole("switch")).toBeChecked();

    const member = await crewMemberByEmail(asha.email);
    expect(member).toMatchObject({ name: asha.name, foodPreference: asha.food, role: asha.role, bio: asha.bio, linkedinUrl: asha.linkedin, showOnPage: true, joinedViaLink: false, sortOrder: 0 });
    const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { id: member!.rsvpId }, select: { status: true, isCrew: true, teamId: true, guestName: true, guestEmail: true, checkInToken: true } });
    expect(rsvp).toMatchObject({ status: RsvpStatus.CONFIRMED, isCrew: true, teamId: null, guestName: asha.name, guestEmail: asha.email });
    // The ticket email is queued in the outbox (a running worker may already have picked it up).
    const queued = await prisma.outboxMessage.findMany({ where: { kind: "crew-ticket", payload: { path: ["to"], equals: asha.email } }, select: { payload: true } });
    expect(queued).toHaveLength(1);
    expect((queued[0]!.payload as { checkInToken?: string }).checkInToken).toBe(rsvp.checkInToken);
    await discardQueuedTestEmail();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("2. food preferences are grouped case-insensitively for catering", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    await addMember(page, ben);
    await addMember(page, cleo);
    await expect(crewRow(page, cleo.name)).toContainText("Food not given");

    const food = page.getByRole("list", { name: "Crew food preferences" }).getByRole("listitem");
    await expect(food).toHaveText(["Vegetarian 2", "Not given 1"]);
    await expect(page.getByText("For 3 crew members.", { exact: false })).toBeVisible();
    await discardQueuedTestEmail();
    expect(errors).toEqual([]);
    await context.close();
  });

  test("3. the crew form refuses a duplicate email and a bare LinkedIn address", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);

    // Emails are normalised, so a different case is still the same crew member.
    const dialog = await fillAddDialog(page, { name: "Ben Again", email: ben.email.toUpperCase() });
    await dialog.getByRole("button", { name: "Add and send ticket" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("This email is already on the crew.");
    await expect(dialog).toBeVisible();

    // The LinkedIn field is type="url": the browser blocks the submit, nothing reaches the server.
    await dialog.getByLabel(/^Email/).fill(`crew-dup-${suffix}@example.test`);
    const linkedin = dialog.getByLabel(/^LinkedIn URL/);
    await linkedin.fill("linkedin.com/in/x");
    await dialog.getByRole("button", { name: "Add and send ticket" }).click();
    expect(await linkedin.evaluate((node) => (node as HTMLInputElement).validity.typeMismatch)).toBe(true);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    expect(await prisma.eventCrewMember.count({ where: { eventId: state.eventId } })).toBe(3);
    expect(await prisma.rSVP.count({ where: { eventId: state.eventId, guestEmail: `crew-dup-${suffix}@example.test` } })).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("4. editing a crew member updates the row and keeps the ticket's name and email in step", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    await crewRow(page, asha.name).getByRole("button", { name: `Edit ${asha.name}` }).click();
    const dialog = page.getByRole("dialog", { name: `Edit ${asha.name}` });
    await expect(dialog.getByLabel(/^Role/)).toHaveValue(asha.role);
    await dialog.getByLabel(/^Name/).fill(ashaEdited.name);
    await dialog.getByLabel(/^Email/).fill(ashaEdited.email);
    await dialog.getByLabel(/^Role/).fill(ashaEdited.role);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${ashaEdited.name} updated` })).toBeVisible();

    const row = crewRow(page, ashaEdited.name);
    await expect(row).toContainText(ashaEdited.role);
    await expect(row).toContainText(ashaEdited.email);
    await expect(row).not.toContainText(asha.role);

    expect(await crewMemberByEmail(asha.email)).toBeNull();
    const member = await crewMemberByEmail(ashaEdited.email);
    expect(member).toMatchObject({ name: ashaEdited.name, role: ashaEdited.role, foodPreference: asha.food });
    const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { id: member!.rsvpId }, select: { guestName: true, guestEmail: true, attendeeKey: true, isCrew: true } });
    expect(rsvp).toEqual({ guestName: ashaEdited.name, guestEmail: ashaEdited.email, attendeeKey: `guest:${ashaEdited.email}`, isCrew: true });
    expect(errors).toEqual([]);
    await context.close();
  });

  test("5. moving the last crew member up reorders the list", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    const names = [ashaEdited.name, ben.name, cleo.name];
    expect(await crewRowNames(page, names)).toEqual([ashaEdited.name, ben.name, cleo.name]);
    await expect(crewRow(page, cleo.name).getByRole("button", { name: `Move ${cleo.name} down` })).toBeDisabled();

    await crewRow(page, cleo.name).getByRole("button", { name: `Move ${cleo.name} up` }).click();
    await expect.poll(() => crewRowNames(page, names)).toEqual([ashaEdited.name, cleo.name, ben.name]);

    const order = await prisma.eventCrewMember.findMany({ where: { eventId: state.eventId }, orderBy: { sortOrder: "asc" }, select: { name: true, sortOrder: true } });
    expect(order).toEqual([
      { name: ashaEdited.name, sortOrder: 0 },
      { name: cleo.name, sortOrder: 1 },
      { name: ben.name, sortOrder: 2 },
    ]);
    // The order survives a reload.
    await page.reload();
    await expect.poll(() => crewRowNames(page, names)).toEqual([ashaEdited.name, cleo.name, ben.name]);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("6. the row switch hides and shows a member on the event page", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    const toggle = crewRow(page, ben.name).getByRole("switch", { name: "Show on event page" });
    await expect(toggle).toBeChecked();
    await hydrated(toggle);

    await toggle.click();
    await expect(page.getByRole("status").filter({ hasText: `${ben.name} is hidden on the event page` })).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect.poll(async () => (await crewMemberByEmail(ben.email))?.showOnPage).toBe(false);

    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByRole("status").filter({ hasText: `${ben.name} is shown on the event page` })).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect.poll(async () => (await crewMemberByEmail(ben.email))?.showOnPage).toBe(true);

    // Reviewing a whole crew is many quick changes; the dashboard budget must allow them.
    for (let flip = 0; flip < 12; flip += 1) {
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeChecked({ checked: flip % 2 === 1 });
    }
    await expect(page.getByText("Too many crew updates")).toHaveCount(0);
    await expect.poll(async () => (await crewMemberByEmail(ben.email))?.showOnPage).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  test("7. adding a registered attendee converts their ticket, and Overview shows crew beside the places", async ({ browser }) => {
    const { context, page, errors } = await ownerContext(browser);
    await openCrewTab(page);
    // Added hidden, so step 10 has a member that must not appear publicly.
    await addMember(page, { name: grace.name, email: grace.email, show: false });
    await expect(crewRow(page, grace.name).getByRole("switch")).not.toBeChecked();

    const member = await crewMemberByEmail(grace.email);
    expect(member).toMatchObject({ rsvpId: state.graceRsvp.id, showOnPage: false, joinedViaLink: false });
    const rsvp = await prisma.rSVP.findUniqueOrThrow({ where: { id: state.graceRsvp.id }, select: { checkInToken: true, isCrew: true, status: true } });
    expect(rsvp).toEqual({ checkInToken: state.graceRsvp.checkInToken, isCrew: true, status: RsvpStatus.CONFIRMED });
    expect(await prisma.rSVP.count({ where: { eventId: state.eventId, OR: [{ guestEmail: grace.email }, { attendeeKey: `guest:${grace.email}` }] } })).toBe(1);
    await discardQueuedTestEmail();

    // Places count attendees only (Nora); the 4 crew are named beside them, and all 5 are going.
    await page.goto(dashboard());
    const going = page.locator("dl > div").filter({ has: page.locator("dt", { hasText: /^Going$/ }) }).first();
    await expect(going.locator("dd")).toContainText("1 / 2");
    await expect(going.locator("dd")).toContainText("+ 4 crew · 5 going");
    expect(errors).toEqual([]);
    await context.close();
  });
}
