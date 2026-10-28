import { EventPermission, RegistrationFieldType, RsvpStatus, SavedViewSurface, type Event } from "@prisma/client";
import { DAY, HOUR, MINUTE, emailFor, guestKey, sha256, token, type Db } from "./common";
import type { People } from "./people";

export const GUESTS = [
  { name: "Amara Okeke", status: RsvpStatus.CONFIRMED, checkedIn: true, dinner: "Yes", diet: "Vegetarian" },
  { name: "Bilal Hussain", status: RsvpStatus.CONFIRMED, checkedIn: true, dinner: "Yes", diet: "Halal" },
  { name: "Carys Morgan", status: RsvpStatus.CONFIRMED, checkedIn: true, dinner: "No" },
  { name: "Daniel Novak", status: RsvpStatus.CONFIRMED, checkedIn: true, dinner: "Yes", diet: "None" },
  { name: "Elif Demir", status: RsvpStatus.CONFIRMED, checkedIn: true, dinner: "Yes", diet: "Vegan" },
  { name: "Finn O'Brien", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "No" },
  { name: "Gabriela Santos", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Harper Lewis", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "Gluten free" },
  { name: "Isaac Mensah", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "No" },
  { name: "Jun Park", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Kavya Iyer", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "Vegetarian" },
  { name: "Liam Walsh", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "No" },
  { name: "Maya Cohen", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Noah Fischer", status: RsvpStatus.CONFIRMED, checkedIn: false, dinner: "Yes", diet: "Nut allergy" },
  { name: "Olivia Brown", status: RsvpStatus.WAITLISTED, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Priya Shah", status: RsvpStatus.WAITLISTED, checkedIn: false, dinner: "No" },
  { name: "Quentin Moreau", status: RsvpStatus.WAITLISTED, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Rosa Alvarez", status: RsvpStatus.PENDING_APPROVAL, checkedIn: false, dinner: "Yes", diet: "Vegetarian" },
  { name: "Sami Virtanen", status: RsvpStatus.PENDING_APPROVAL, checkedIn: false, dinner: "No" },
  { name: "Tomás Silva", status: RsvpStatus.PENDING_APPROVAL, checkedIn: false, dinner: "Yes", diet: "None" },
  { name: "Uma Patel", status: RsvpStatus.REJECTED, checkedIn: false, dinner: "No" },
  { name: "Victor Laine", status: RsvpStatus.REJECTED, checkedIn: false, dinner: "No" },
] as const;

/** Registrations, invitations, co-organisers, saved views and check-in lists for the main event. */
export async function seedMainGuests(prisma: Db, people: People, main: Event, now: number) {
  const { owner, admin, coOrganiser, org } = people;
  // Two registration questions; the second only shows when the first is "Yes".
  const form = await prisma.eventRegistrationForm.create({
    data: {
      eventId: main.id,
      fields: {
        create: [
          { key: "pizza_dinner", label: "Will you join us for pizza?", type: RegistrationFieldType.RADIO, required: true, sortOrder: 0, options: ["Yes", "No"] },
          {
            key: "dietary", label: "Any dietary requirements?", type: RegistrationFieldType.TEXT, required: false, sortOrder: 1,
            placeholder: "For example vegetarian or nut allergy", settings: { showIf: { fieldKey: "pizza_dinner", values: ["Yes"] } },
          },
        ],
      },
    },
    include: { fields: true },
  });
  const dinnerField = form.fields.find((field) => field.key === "pizza_dinner")!;
  const dietField = form.fields.find((field) => field.key === "dietary")!;

  const rsvps: { id: string; checkInToken: string; name: string; status: RsvpStatus; checkedIn: boolean }[] = [];
  for (const [index, guest] of GUESTS.entries()) {
    const email = emailFor(guest.name);
    const occurredAt = new Date(now - 2 * HOUR + index * MINUTE);
    const rsvp = await prisma.rSVP.create({
      data: {
        eventId: main.id, guestEmail: email, guestName: guest.name, attendeeKey: guestKey(email), status: guest.status,
        checkedInAt: guest.checkedIn ? occurredAt : null, createdAt: new Date(now - (20 - index * 0.8) * DAY),
        answers: {
          create: [
            { fieldId: dinnerField.id, valueText: guest.dinner },
            ...("diet" in guest && guest.diet ? [{ fieldId: dietField.id, valueText: guest.diet }] : []),
          ],
        },
      },
      select: { id: true, checkInToken: true },
    });
    if (guest.checkedIn) {
      await prisma.checkInEvent.create({ data: { rsvpId: rsvp.id, actorUserId: owner.id, action: "CHECKED_IN", source: "online", occurredAt } });
    }
    rsvps.push({ ...rsvp, name: guest.name, status: guest.status, checkedIn: guest.checkedIn });
  }

  for (const [index, email] of ["sophie.turner@example.org", "marcus.reid@example.org", "hana.sato@example.org", "oscar.nilsson@example.org"].entries()) {
    await prisma.eventInvite.create({ data: { eventId: main.id, email, createdAt: new Date(now - (4 - index) * DAY) } });
  }

  // One active co-organiser and one pending invitation.
  await prisma.eventCollaborator.create({
    data: { eventId: main.id, userId: coOrganiser.id, permissions: [EventPermission.EDIT_DETAILS, EventPermission.CHECK_IN, EventPermission.MANAGE_REGISTRATIONS] },
  });
  await prisma.eventCollaboratorInvite.create({
    data: {
      eventId: main.id, email: "gita.volunteer@example.org", tokenHash: sha256(token()), permissions: [EventPermission.CHECK_IN],
      createdByUserId: owner.id, expiresAt: new Date(now + 6 * DAY),
    },
  });

  // Saved views on Guests · People: one of Ada's own and one Ben shared.
  await prisma.savedView.createMany({
    data: [
      { organisationId: org.id, eventId: main.id, userId: owner.id, surface: SavedViewSurface.GUESTS_PEOPLE, name: "Going only", params: { status: "going" }, shared: false },
      { organisationId: org.id, eventId: main.id, userId: admin.id, surface: SavedViewSurface.GUESTS_PEOPLE, name: "Needs a decision", params: { status: "approve" }, shared: true },
    ],
  });

  // Custom check-in lists: Swag collection with some guests collected.
  const swag = await prisma.checkInList.create({ data: { eventId: main.id, name: "Swag collection", sortOrder: 0 } });
  await prisma.checkInList.create({ data: { eventId: main.id, name: "Pizza dinner", sortOrder: 1 } });
  for (const rsvp of rsvps.filter((guest) => guest.checkedIn).slice(0, 3)) {
    await prisma.checkInListRecord.create({ data: { listId: swag.id, rsvpId: rsvp.id, actorUserId: owner.id, source: "online" } });
    await prisma.checkInListEvent.create({ data: { listId: swag.id, rsvpId: rsvp.id, actorUserId: owner.id, action: "CHECKED_IN", source: "online" } });
  }

  const ticket = rsvps.find((guest) => guest.status === RsvpStatus.CONFIRMED && !guest.checkedIn)!;
  return { rsvps, ticketToken: ticket.checkInToken };
}

export const mainGuestEmails = () => GUESTS.map((guest) => emailFor(guest.name));
