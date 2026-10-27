import "server-only";

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { notifyChatAbout } from "@/lib/chat/notify";
import { enqueueCrewTicket } from "@/lib/outbox/crew";
import { fillFromWaitlist } from "@/lib/payments/operations";
import { isOrganisationUploadUrl } from "@/lib/uploadUrl";
import { rsvpWebhookSnapshot, rsvpWebhookSnapshotSelect } from "@/lib/teamUnits";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import {
  ALREADY_ON_CREW,
  ALREADY_REGISTERED,
  CREW_PHOTO_CATEGORY,
  MAX_CREW_MEMBERS,
  cleanProfile,
  eventForCrewSelect,
  fail,
  isUniqueViolation,
  lockEventForCrew,
  organiserCrewSchema,
  summariseFoodPreferences,
  uniqueViolationModel,
  type CrewProfileInput,
  type CrewResult,
  type EventForCrew,
  type OrganiserCrewContext,
} from "./shared";

/*
 * Crew members (docs/CREW.md). Every member owns one CONFIRMED RSVP with
 * `isCrew`: a free ticket with no order, ticket type or team, never counted
 * against capacity. Callers authorise first: organiser functions take an
 * OrganiserCrewContext resolved with MANAGE_REGISTRATIONS.
 */

/** Returned instead of a reason when a link sign-up must not change anything; the caller answers as for a duplicate. */
export const LINK_SIGNUP_IGNORED = "link-signup-ignored";
const BOUGHT_A_TICKET = "This person bought a ticket. Cancel or refund their order first.";

const organiserCrewSelect = {
  id: true, name: true, email: true, foodPreference: true, role: true, bio: true, photoUrl: true, linkedinUrl: true,
  showOnPage: true, joinedViaLink: true, sortOrder: true, createdAt: true,
  rsvp: { select: { id: true, checkedInAt: true } },
} as const satisfies Prisma.EventCrewMemberSelect;

export type OrganiserCrewMember = {
  id: string; name: string; email: string; foodPreference: string; role: string; bio: string;
  photoUrl: string | null; linkedinUrl: string | null; showOnPage: boolean; joinedViaLink: boolean;
  sortOrder: number; createdAt: string; rsvpId: string; checkedInAt: string | null;
};

function toOrganiserCrewMember(row: Prisma.EventCrewMemberGetPayload<{ select: typeof organiserCrewSelect }>): OrganiserCrewMember {
  const { rsvp, createdAt, ...rest } = row;
  return { ...rest, createdAt: createdAt.toISOString(), rsvpId: rsvp.id, checkedInAt: rsvp.checkedInAt?.toISOString() ?? null };
}

export async function listCrewForOrganiser(ctx: OrganiserCrewContext): Promise<{ members: OrganiserCrewMember[]; food: Array<{ label: string; count: number }> }> {
  const rows = await prisma.eventCrewMember.findMany({
    where: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: organiserCrewSelect,
    take: MAX_CREW_MEMBERS,
  });
  const members = rows.map(toOrganiserCrewMember);
  return { members, food: summariseFoodPreferences(members.map((member) => member.foodPreference)) };
}

type AddOutcome = { id: string; rsvpId: string; webhook: WebhookEmission | null; freedPlace: boolean };

/**
 * Add one crew member and queue their ticket. An organiser adding an email
 * that already has a free solo registration turns it into the crew ticket
 * (same QR code and check-in; a confirmed place is freed and offered to the
 * waitlist). Paid tickets, team members, hackathon entrants and link
 * sign-ups never convert.
 */
export async function addCrewMemberTx(
  event: EventForCrew,
  profile: CrewProfileInput,
  options: { showOnPage: boolean; joinedViaLink: boolean },
): Promise<CrewResult<AddOutcome>> {
  const data = cleanProfile(profile);
  if (data.photoUrl && !isOrganisationUploadUrl(data.photoUrl, event.organisationId, CREW_PHOTO_CATEGORY)) return fail("Choose an uploaded crew photo.");
  try {
    return await prisma.$transaction(async (tx): Promise<CrewResult<AddOutcome>> => {
      const locked = await lockEventForCrew(tx, event.id);
      if (!locked) return fail("Event not found.");
      if ((await tx.eventCrewMember.count({ where: { eventId: event.id } })) >= MAX_CREW_MEMBERS) return fail(`An event can have up to ${MAX_CREW_MEMBERS} crew members.`);
      if (await tx.eventCrewMember.findUnique({ where: { eventId_email: { eventId: event.id, email: data.email } }, select: { id: true } })) return fail(ALREADY_ON_CREW);
      const existing = await tx.rSVP.findFirst({
        where: { eventId: event.id, OR: [{ attendeeKey: `guest:${data.email}` }, { guestEmail: { equals: data.email, mode: "insensitive" } }, { user: { email: { equals: data.email, mode: "insensitive" } } }] },
        select: { id: true, status: true, teamId: true, orderId: true, ticketTypeId: true, userId: true, submission: { select: { id: true } } },
      });
      // The crew link proves nothing about who owns an email, so a link
      // sign-up never turns a registration into a crew ticket; answered like
      // a duplicate so the link reveals nothing about who is registered.
      if (existing && options.joinedViaLink) return fail(LINK_SIGNUP_IGNORED);
      if (existing && (existing.orderId || existing.ticketTypeId || existing.status === RsvpStatus.PENDING_PAYMENT)) return fail(BOUGHT_A_TICKET);
      if (existing?.teamId) return fail("This person is registered in a team. Remove them from their team before adding them to the crew.");
      if (existing?.submission) return fail("This person has a hackathon project. Withdraw or remove it before adding them to the crew.");
      let rsvp: { id: string; checkInToken: string };
      let webhook: WebhookEmission | null = null;
      if (existing) {
        rsvp = await tx.rSVP.update({
          where: { id: existing.id },
          // A guest ticket takes the crew name; an account-linked one keeps the account's identity.
          data: { isCrew: true, status: RsvpStatus.CONFIRMED, holdExpiresAt: null, ...(existing.userId ? {} : { guestName: data.name }) },
          select: { id: true, checkInToken: true },
        });
        // A seeker listing or join request would let teams invite a crew member.
        await tx.teamSeekerProfile.deleteMany({ where: { rsvpId: existing.id } });
        await tx.teamJoinRequest.deleteMany({ where: { rsvpId: existing.id } });
        if (existing.status !== RsvpStatus.CONFIRMED) webhook = { type: "registration.status_changed", rsvpId: existing.id, status: RsvpStatus.CONFIRMED, previousStatus: existing.status };
      } else {
        rsvp = await tx.rSVP.create({
          data: { eventId: event.id, guestEmail: data.email, guestName: data.name, attendeeKey: `guest:${data.email}`, status: RsvpStatus.CONFIRMED, isCrew: true },
          select: { id: true, checkInToken: true },
        });
        webhook = { type: "registration.created", rsvpId: rsvp.id };
      }
      const last = await tx.eventCrewMember.aggregate({ where: { eventId: event.id }, _max: { sortOrder: true } });
      const member = await tx.eventCrewMember.create({
        data: { eventId: event.id, rsvpId: rsvp.id, ...data, showOnPage: options.showOnPage, joinedViaLink: options.joinedViaLink, sortOrder: (last._max.sortOrder ?? -1) + 1 },
        select: { id: true },
      });
      await enqueueCrewTicket(tx, { to: data.email, checkInToken: rsvp.checkInToken, organisationId: locked.organisationId });
      if (options.joinedViaLink) await notifyChatAbout(tx, { eventId: event.id }, "registration", (title) => `${data.name} joined the crew for ${title}.`);
      return { ok: true, data: { id: member.id, rsvpId: rsvp.id, webhook, freedPlace: existing?.status === RsvpStatus.CONFIRMED } };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail(uniqueViolationModel(error) === "EventCrewMember" ? ALREADY_ON_CREW : ALREADY_REGISTERED);
    throw error;
  }
}

/** After commit: the registration webhook, and the freed place offered to the waitlist. */
export async function afterCrewAdded(eventId: string, result: CrewResult<AddOutcome>) {
  if (!result.ok) return;
  if (result.data.webhook) emitWebhookEvent(result.data.webhook);
  if (result.data.freedPlace) await fillFromWaitlist({ eventId }).catch(() => 0);
}

export async function organiserEvent(ctx: OrganiserCrewContext): Promise<EventForCrew | null> {
  return prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: eventForCrewSelect });
}

export async function addCrewMemberAsOrganiser(ctx: OrganiserCrewContext, input: unknown): Promise<CrewResult<{ id: string }>> {
  const parsed = organiserCrewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the crew member's details.");
  const event = await organiserEvent(ctx);
  if (!event) return fail("Event not found.");
  const { showOnPage, ...profile } = parsed.data;
  const result = await addCrewMemberTx(event, profile, { showOnPage, joinedViaLink: false });
  await afterCrewAdded(event.id, result);
  return result.ok ? { ok: true, data: { id: result.data.id } } : result;
}

export async function updateCrewMemberAsOrganiser(ctx: OrganiserCrewContext, memberId: string, input: unknown): Promise<CrewResult> {
  const parsed = organiserCrewSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the crew member's details.");
  const event = await organiserEvent(ctx);
  if (!event) return fail("Event not found.");
  const { showOnPage, ...profile } = parsed.data;
  const data = cleanProfile(profile);
  if (data.photoUrl && !isOrganisationUploadUrl(data.photoUrl, event.organisationId, CREW_PHOTO_CATEGORY)) {
    // A member can keep the photo they already have; anything else must be a fresh crew upload.
    const current = await prisma.eventCrewMember.findFirst({ where: { id: memberId, eventId: event.id }, select: { photoUrl: true } });
    if (current?.photoUrl !== data.photoUrl) return fail("Choose an uploaded crew photo.");
  }
  try {
    return await prisma.$transaction(async (tx): Promise<CrewResult> => {
      const member = await tx.eventCrewMember.findFirst({ where: { id: memberId, eventId: event.id }, select: { id: true, email: true, rsvpId: true, rsvp: { select: { userId: true, checkInToken: true } } } });
      if (!member) return fail("Crew member not found.");
      await tx.eventCrewMember.update({ where: { id: member.id }, data: { ...data, showOnPage } });
      // A new address gets the ticket too; the old one keeps working (same QR).
      if (data.email !== member.email) await enqueueCrewTicket(tx, { to: data.email, checkInToken: member.rsvp.checkInToken, organisationId: event.organisationId });
      // An account-linked ticket takes its identity from the account, so only guest tickets change.
      if (!member.rsvp.userId) {
        await tx.rSVP.update({ where: { id: member.rsvpId }, data: { guestName: data.name, guestEmail: data.email, attendeeKey: `guest:${data.email}` } });
      }
      return { ok: true, data: undefined };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail(uniqueViolationModel(error) === "EventCrewMember" ? ALREADY_ON_CREW : ALREADY_REGISTERED);
    throw error;
  }
}

/** Quick show/hide from the crew list without reopening the form. */
export async function setCrewMemberVisibility(ctx: OrganiserCrewContext, memberId: string, showOnPage: boolean): Promise<CrewResult> {
  const updated = await prisma.eventCrewMember.updateMany({ where: { id: memberId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } }, data: { showOnPage } });
  return updated.count === 1 ? { ok: true, data: undefined } : fail("Crew member not found.");
}

/** Removing a crew member deletes their free crew ticket (and its check-in) with them. */
export async function removeCrewMember(ctx: OrganiserCrewContext, memberId: string): Promise<CrewResult<{ name: string }>> {
  const member = await prisma.eventCrewMember.findFirst({
    where: { id: memberId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    select: { name: true, rsvp: { select: rsvpWebhookSnapshotSelect } },
  });
  if (!member) return fail("Crew member not found.");
  // The crew row cascades from the RSVP. Crew tickets never have an order, so nothing is refunded.
  const removed = await prisma.rSVP.deleteMany({ where: { id: member.rsvp.id, eventId: ctx.eventId, isCrew: true, orderId: null } });
  // Lost a race with another removal: nothing was deleted here.
  if (removed.count !== 1) return fail("Crew member not found.");
  emitWebhookEvent({ type: "registration.status_changed", rsvpId: member.rsvp.id, status: "CANCELLED", previousStatus: RsvpStatus.CONFIRMED, snapshot: rsvpWebhookSnapshot(member.rsvp) });
  return { ok: true, data: { name: member.name } };
}

export async function moveCrewMember(ctx: OrganiserCrewContext, memberId: string, direction: -1 | 1): Promise<CrewResult> {
  return prisma.$transaction(async (tx): Promise<CrewResult> => {
    const rows = await tx.eventCrewMember.findMany({
      where: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    const index = rows.findIndex((row) => row.id === memberId);
    if (index < 0) return fail("Crew member not found.");
    const swap = index + direction;
    if (swap < 0 || swap >= rows.length) return { ok: true, data: undefined };
    [rows[index], rows[swap]] = [rows[swap]!, rows[index]!];
    for (const [sortOrder, row] of rows.entries()) await tx.eventCrewMember.update({ where: { id: row.id }, data: { sortOrder } });
    return { ok: true, data: undefined };
  });
}
