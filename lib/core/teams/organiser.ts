import "server-only";
import { admissionJoinRefusal } from "@/lib/admission/registration";

import { EventStatus, RegistrationMode, RsvpStatus, TeamJoinRequestStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { retireSoloSubmissionForTeamTx } from "@/lib/core/submissionLifecycle";
import { countConfirmedUnits, isEventCancelled, promoteOldestWaitlistedUnit, setTeamStatusTx, settleTeamAfterMemberLeft, teamPlacesTaken } from "@/lib/teamUnits";
import { refundWholeOrderTx, submitRefunds } from "@/lib/payments/operations";
import { leadsPaidTeam, paidOrdersOfTeam } from "@/lib/payments/teamOrders";
import { teamNameSchema } from "@/lib/validators";
import {
  fail,
  hasFreeSpace,
  isUniqueViolationOn,
  lockEvent,
  NOT_A_TEAM_EVENT,
  personEmail,
  renameTeamTx,
  TEAM_NOT_FOUND,
  teamTransaction,
  type OrganiserEventContext,
  type TeamResult,
} from "./shared";

// ---------------------------------------------------------------------------
// Organiser actions (whole teams)
// ---------------------------------------------------------------------------

export type TeamTransition = "approve" | "reject" | "promote";

/**
 * Approve, reject, or promote a whole team as one unit. Approval needs the
 * event to be open and the team to reach `teamMinSize`; approval and
 * promotion need a free unit and refuse a cancelled event. All member RSVPs change in the same
 * transaction and each member gets the usual status email naming the team.
 */
export async function transitionTeamStatus(
  ctx: OrganiserEventContext,
  teamId: string,
  action: TeamTransition,
): Promise<TeamResult<{ status: RsvpStatus }>> {
  if (!teamId || teamId.length > 128) return fail(TEAM_NOT_FOUND);
  const refundIds: string[] = [];
  const result = await teamTransaction(async (tx, webhooks): Promise<TeamResult<{ status: RsvpStatus }>> => {
    const event = await lockEvent(tx, ctx.eventId);
    if (!event || event.organisationId !== ctx.organisationId) return fail("Event not found.");
    const team = await tx.team.findFirst({ where: { id: teamId, eventId: event.id }, select: { id: true, status: true } });
    if (!team) return fail(TEAM_NOT_FOUND);
    const changed = fail("This team was changed by another organiser.");
    if (action === "reject") {
      if (team.status !== RsvpStatus.PENDING_APPROVAL && team.status !== RsvpStatus.WAITLISTED) return fail("This team cannot be rejected.");
      const rejected = await setTeamStatusTx(tx, { teamId: team.id, eventId: event.id, eventTitle: event.title, from: [team.status], to: RsvpStatus.REJECTED });
      if (!rejected) return changed;
      webhooks.push(...rejected);
      // Paid places come back in full: the organiser turned the team down.
      for (const orderId of await paidOrdersOfTeam(tx, team.id)) {
        refundIds.push(...(await refundWholeOrderTx(tx, { orderId, reason: "Team rejected by the organiser", actorUserId: ctx.userId })));
      }
      return { ok: true, data: { status: RsvpStatus.REJECTED } };
    }
    if (action === "approve") {
      if (team.status !== RsvpStatus.PENDING_APPROVAL) return fail("Only pending teams can be approved.");
      if (event.status !== EventStatus.PUBLISHED || event.endDateTime <= new Date()) return fail("This event is no longer open for approvals.");
      const size = await tx.rSVP.count({ where: { teamId: team.id } });
      if (event.teamMinSize != null && size < event.teamMinSize) {
        return fail(`This team is incomplete (${size} of at least ${event.teamMinSize} members), so it can't be approved yet.`, "TEAM_INCOMPLETE");
      }
    } else if (team.status !== RsvpStatus.WAITLISTED) {
      return fail("Only waitlisted teams can be promoted.");
    }
    // The same guard as automatic promotion (lib/teamUnits.ts), under the Event lock above.
    if (await isEventCancelled(tx, event.id)) return fail("This event has been cancelled, so no team can be confirmed.");
    if (event.capacity != null && (await countConfirmedUnits(tx, event.id)) >= event.capacity) {
      return fail(action === "approve" ? "Event is at capacity. Free a spot or promote from waitlist first." : "Event is still at capacity.", "CAPACITY_FULL");
    }
    const confirmed = await setTeamStatusTx(tx, { teamId: team.id, eventId: event.id, eventTitle: event.title, from: [team.status], to: RsvpStatus.CONFIRMED });
    if (!confirmed) return changed;
    webhooks.push(...confirmed);
    return { ok: true, data: { status: RsvpStatus.CONFIRMED } };
  });
  await submitRefunds(refundIds);
  return result;
}

const moveMemberSchema = z.object({ rsvpId: z.string().trim().min(1).max(128), targetTeamId: z.string().trim().min(1).max(128) }).strict();

/** Move a registration (solo or from another team) into a team of the same event. */
export async function organiserMoveMember(
  ctx: OrganiserEventContext,
  input: unknown,
): Promise<TeamResult<{ status: RsvpStatus }>> {
  const parsed = moveMemberSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid input.");
  return teamTransaction(async (tx, webhooks): Promise<TeamResult<{ status: RsvpStatus }>> => {
    const event = await lockEvent(tx, ctx.eventId);
    if (!event || event.organisationId !== ctx.organisationId) return fail("Event not found.");
    if (event.registrationMode !== RegistrationMode.TEAM) return fail(NOT_A_TEAM_EVENT);
    // Locked before its check-in state is read: check-in takes only this row lock, not the Event's.
    await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${parsed.data.rsvpId} AND "eventId" = ${event.id} FOR UPDATE`;
    const rsvp = await tx.rSVP.findFirst({
      // Crew tickets (docs/CREW.md) never join a team.
      where: { id: parsed.data.rsvpId, eventId: event.id, isCrew: false },
      select: { id: true, teamId: true, status: true, checkedInAt: true, checkInToken: true, guestEmail: true, user: { select: { email: true } } },
    });
    if (!rsvp) return fail("RSVP not found.");
    if (rsvp.status === RsvpStatus.PENDING_PAYMENT) return fail("This person is still paying for their ticket.");
    // A PER_TEAM leader's ticket paid for their team; it can't move with them.
    if (await leadsPaidTeam(tx, rsvp.id)) return fail("This person paid for their team's ticket, so they can't move to another team.");
    const target = await tx.team.findFirst({ where: { id: parsed.data.targetTeamId, eventId: event.id }, select: { id: true, name: true, status: true } });
    if (!target) return fail(TEAM_NOT_FOUND);
    if (target.status === RsvpStatus.PENDING_PAYMENT) return fail("That team's leader is still paying for it.");
    if (rsvp.teamId === target.id) return fail("This person is already in that team.");
    if (target.status === RsvpStatus.REJECTED) return fail("A rejected team can't take new members.");
    // Applications (docs/ADMISSION.md): a decided team takes nobody new; a closed applicant joins nobody.
    const closed = await admissionJoinRefusal(tx, { teamId: target.id, rsvpId: rsvp.teamId ? null : rsvp.id });
    if (closed) return fail(closed);
    // A checked-in person is at the event: moving them into a team without a
    // place would release their unit to the waitlist while they stay inside.
    if (rsvp.checkedInAt && target.status !== RsvpStatus.CONFIRMED) {
      return fail("This person has already checked in, so they can only move to a confirmed team.");
    }
    if (!hasFreeSpace(event, await teamPlacesTaken(tx, target.id))) return fail("That team is already full.");
    // A solo registration's own project can't come into the team (a team
    // member's project stays with the team they leave).
    if (!rsvp.teamId) {
      const retired = await retireSoloSubmissionForTeamTx(tx, { rsvpId: rsvp.id, eventId: event.id, by: "organiser" });
      if (!retired.ok) return fail(retired.error);
    }
    const moved = await tx.rSVP.updateMany({
      where: { id: rsvp.id, eventId: event.id, teamId: rsvp.teamId, status: rsvp.status, checkedInAt: rsvp.checkedInAt },
      data: { teamId: target.id, status: target.status },
    });
    if (moved.count !== 1) return fail("This registration was changed by another organiser.");
    if (rsvp.status !== target.status) {
      webhooks.push({ type: "registration.status_changed", rsvpId: rsvp.id, status: target.status, previousStatus: rsvp.status });
    }
    await tx.teamJoinRequest.updateMany({ where: { rsvpId: rsvp.id, status: TeamJoinRequestStatus.PENDING }, data: { status: TeamJoinRequestStatus.CANCELLED } });
    await tx.teamSeekerProfile.updateMany({ where: { rsvpId: rsvp.id }, data: { visible: false } });
    let freedUnit = !rsvp.teamId && rsvp.status === RsvpStatus.CONFIRMED;
    if (rsvp.teamId) {
      const settled = await settleTeamAfterMemberLeft(tx, { teamId: rsvp.teamId, eventId: event.id, leftRsvpId: rsvp.id });
      freedUnit = settled.freedConfirmedUnit;
    }
    if (rsvp.status !== RsvpStatus.CONFIRMED && target.status === RsvpStatus.CONFIRMED) {
      const to = personEmail(rsvp);
      if (to) await enqueueRsvpStatusNotification(tx, { to, eventTitle: event.title, approved: true, checkInToken: rsvp.checkInToken, teamName: target.name });
    }
    if (freedUnit) webhooks.push(...((await promoteOldestWaitlistedUnit(tx, event))?.webhooks ?? []));
    return { ok: true, data: { status: target.status } };
  });
}

export async function organiserRenameTeam(ctx: OrganiserEventContext, teamId: string, name: unknown): Promise<TeamResult<{ name: string }>> {
  const parsed = teamNameSchema.safeParse(name);
  if (!parsed.success) return { ok: false, error: "Enter a valid team name.", fieldErrors: { name: parsed.error.issues.map((i) => i.message) } };
  if (!teamId || teamId.length > 128) return fail(TEAM_NOT_FOUND);
  try {
    return await prisma.$transaction(async (tx): Promise<TeamResult<{ name: string }>> => {
      const event = await lockEvent(tx, ctx.eventId);
      if (!event || event.organisationId !== ctx.organisationId) return fail("Event not found.");
      const team = await tx.team.findFirst({ where: { id: teamId, eventId: event.id }, select: { id: true, eventId: true } });
      if (!team) return fail(TEAM_NOT_FOUND);
      return renameTeamTx(tx, team, parsed.data);
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "nameKey")) return fail("That team name is already taken for this event.");
    throw error;
  }
}
