import "server-only";

import { EventPrivacyType, RegistrationMode, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { flattenZodErrors } from "@/app/actions/utils";
import { enqueueTeamCreated, enqueueTeamMemberAdded } from "@/lib/outbox";
import {
  assignTeamLeaderTx,
  promoteOldestWaitlistedUnit,
  rsvpWebhookSnapshot,
  rsvpWebhookSnapshotSelect,
  settleTeamAfterMemberLeft,
} from "@/lib/teamUnits";
import { generateTeamManageToken, generateTeamToken, teamJoinPath, teamManagePath } from "@/lib/teamToken";
import { addTeamMemberSchema, renameTeamSchema } from "@/lib/validators";
import { resolveRsvpByTicketToken } from "./resolvers";
import {
  fail,
  hasFreeSpace,
  INVITE_ONLY_ADD_REFUSED,
  isOpenForRegistration,
  isUniqueViolation,
  isUniqueViolationOn,
  lockedLeaderTeam,
  lockEvent,
  NOT_A_TEAM_EVENT,
  personName,
  renameTeamTx,
  TEAM_DECLINED,
  TEAM_NOT_FOUND,
  teamTransaction,
  type TeamLeaderAuth,
  type TeamResult,
} from "./shared";

// ---------------------------------------------------------------------------
// Leader actions
// ---------------------------------------------------------------------------

/**
 * The leader adds a member by name and email. Registration-open checks apply,
 * custom questions are skipped (as with organiser manual add), and the
 * member's own ticket is emailed through the outbox; the ticket token is
 * never returned to the leader.
 */
export async function addTeamMemberByLeader(
  auth: TeamLeaderAuth,
  input: unknown,
): Promise<TeamResult<{ rsvpId: string; status: RsvpStatus }>> {
  const parsed = addTeamMemberSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  const email = parsed.data.email.trim().toLowerCase();
  try {
    return await teamTransaction(async (tx, webhooks): Promise<TeamResult<{ rsvpId: string; status: RsvpStatus }>> => {
      const event = await lockEvent(tx, auth.eventId);
      if (!event) return fail(TEAM_NOT_FOUND);
      if (event.registrationMode !== RegistrationMode.TEAM) return fail(NOT_A_TEAM_EVENT);
      if (!isOpenForRegistration(event)) return fail("Registration is closed for this event.");
      const team = await lockedLeaderTeam(tx, auth);
      if (!team) return fail(TEAM_NOT_FOUND);
      if (team.status === RsvpStatus.REJECTED) return fail("This team can no longer take new members.");
      // Same rule as public guest registration (rsvpCore): an entered address
      // on the invite list proves nothing, so invite-only events never issue a
      // guest ticket here. Invitees sign in with the invited account and use
      // the join link instead.
      if (event.privacyType === EventPrivacyType.INVITE_ONLY) return fail(INVITE_ONLY_ADD_REFUSED);
      const size = await tx.rSVP.count({ where: { teamId: team.id } });
      if (!hasFreeSpace(event, size)) return fail("Your team is already full.");
      const rsvp = await tx.rSVP.create({
        data: {
          eventId: event.id,
          userId: null,
          guestEmail: email,
          guestName: parsed.data.name.trim(),
          attendeeKey: `guest:${email}`,
          status: team.status,
          teamId: team.id,
        },
        select: { id: true, checkInToken: true },
      });
      const leaderName = team.leaderRsvp ? personName(team.leaderRsvp) : undefined;
      await enqueueTeamMemberAdded(tx, {
        to: email,
        checkInToken: rsvp.checkInToken,
        ...(leaderName && leaderName !== "Guest" ? { addedByName: leaderName } : {}),
      });
      webhooks.push({ type: "registration.created", rsvpId: rsvp.id });
      return { ok: true, data: { rsvpId: rsvp.id, status: team.status } };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return fail("This email is already registered for this event.");
    console.error("[teams] add member failed");
    return fail("Could not add this member.");
  }
}

/** Remove a member (not the leader). Cancels their registration. */
export async function removeTeamMember(auth: TeamLeaderAuth, rsvpId: string): Promise<TeamResult> {
  if (!rsvpId || rsvpId.length > 128) return fail("Member not found.");
  return teamTransaction(async (tx, webhooks): Promise<TeamResult> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    if (team.leaderRsvpId === rsvpId) return fail("You can't remove yourself. Transfer leadership or disband the team instead.");
    const member = await tx.rSVP.findFirst({
      where: { id: rsvpId, eventId: event.id, teamId: team.id },
      select: { ...rsvpWebhookSnapshotSelect, status: true },
    });
    if (!member) return fail("Member not found.");
    if (member.checkedInAt) return fail("This member has already checked in.");
    await tx.rSVP.delete({ where: { id: member.id } });
    // The team side of the registration cancels it, as when the member leaves.
    webhooks.push({ type: "registration.status_changed", rsvpId: member.id, status: "CANCELLED", previousStatus: member.status, snapshot: rsvpWebhookSnapshot(member) });
    const settled = await settleTeamAfterMemberLeft(tx, { teamId: team.id, eventId: event.id, leftRsvpId: member.id });
    if (settled.freedConfirmedUnit) webhooks.push(...((await promoteOldestWaitlistedUnit(tx, event))?.webhooks ?? []));
    return { ok: true };
  });
}

/**
 * A member leaves from their ticket page. Leaving cancels the registration,
 * through the same cancellation core (leadership passes on, an empty team is
 * deleted and its unit freed).
 */
export async function leaveTeam(actorUserId: string | null, ticketToken: string): Promise<TeamResult<{ cancelled: true }>> {
  const holder = await resolveRsvpByTicketToken(ticketToken, actorUserId);
  if (!holder) return fail("Registration not found.");
  if (!holder.teamId) return fail("You're not in a team.");
  // Events cancels as the signed-in visitor of this request (the same actor).
  // Loaded on use, so importing these cores never pulls in the auth runtime.
  const { cancelRsvp } = await import("@/app/actions/rsvp-cancel");
  return cancelRsvp({ checkInToken: ticketToken });
}

/** Hand leadership to another member. Rotates the management link and emails it to the new leader. */
export async function transferLeadership(auth: TeamLeaderAuth, newLeaderRsvpId: string): Promise<TeamResult> {
  if (!newLeaderRsvpId || newLeaderRsvpId.length > 128) return fail("Member not found.");
  return prisma.$transaction(async (tx): Promise<TeamResult> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    if (team.status === RsvpStatus.REJECTED) return fail(TEAM_DECLINED);
    if (team.leaderRsvpId === newLeaderRsvpId) return fail("This member already leads the team.");
    const member = await tx.rSVP.findFirst({ where: { id: newLeaderRsvpId, eventId: event.id, teamId: team.id }, select: { id: true } });
    if (!member) return fail("Member not found.");
    await assignTeamLeaderTx(tx, { teamId: team.id, leaderRsvpId: member.id, reason: "leader" });
    return { ok: true };
  });
}

export async function renameTeam(auth: TeamLeaderAuth, input: unknown): Promise<TeamResult<{ name: string }>> {
  const parsed = renameTeamSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  try {
    return await prisma.$transaction(async (tx): Promise<TeamResult<{ name: string }>> => {
      const event = await lockEvent(tx, auth.eventId);
      if (!event) return fail(TEAM_NOT_FOUND);
      const team = await lockedLeaderTeam(tx, auth);
      if (!team) return fail(TEAM_NOT_FOUND);
    if (team.status === RsvpStatus.REJECTED) return fail(TEAM_DECLINED);
      return renameTeamTx(tx, team, parsed.data.name);
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "nameKey")) return fail("That team name is already taken for this event.");
    throw error;
  }
}

/** New join link; the old one stops working immediately. */
export async function regenerateJoinToken(auth: TeamLeaderAuth): Promise<TeamResult<{ joinToken: string; joinPath: string }>> {
  return prisma.$transaction(async (tx): Promise<TeamResult<{ joinToken: string; joinPath: string }>> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    if (team.status === RsvpStatus.REJECTED) return fail(TEAM_DECLINED);
    const joinToken = generateTeamToken();
    await tx.team.update({ where: { id: team.id }, data: { joinToken } });
    const org = await tx.organisation.findUnique({ where: { id: event.organisationId }, select: { slug: true } });
    return { ok: true, data: { joinToken, joinPath: teamJoinPath(org?.slug ?? "", event.slug, joinToken) } };
  });
}

/**
 * New management link; the old one stops working immediately. The raw token
 * is returned once so the page can move to the new address, and is emailed to
 * the leader (outbox `team-created`, reason `reset`) so the team stays
 * manageable if that tab is lost; only its hash is stored.
 */
export async function regenerateManageToken(auth: TeamLeaderAuth): Promise<TeamResult<{ manageToken: string; managePath: string }>> {
  return prisma.$transaction(async (tx): Promise<TeamResult<{ manageToken: string; managePath: string }>> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    if (team.status === RsvpStatus.REJECTED) return fail(TEAM_DECLINED);
    const manage = generateTeamManageToken();
    await tx.team.update({ where: { id: team.id }, data: { manageTokenHash: manage.hash } });
    const leader = team.leaderRsvpId
      ? await tx.rSVP.findUnique({ where: { id: team.leaderRsvpId }, select: { guestEmail: true, user: { select: { email: true } } } })
      : null;
    const to = leader?.user?.email?.trim() || leader?.guestEmail;
    if (to) await enqueueTeamCreated(tx, { to, teamId: team.id, manageToken: manage.raw, reason: "reset" });
    return { ok: true, data: { manageToken: manage.raw, managePath: teamManagePath(manage.raw) } };
  });
}

export async function setLookingForMembers(auth: TeamLeaderAuth, looking: boolean): Promise<TeamResult> {
  if (typeof looking !== "boolean") return fail("Invalid input.");
  return prisma.$transaction(async (tx): Promise<TeamResult> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    if (team.status === RsvpStatus.REJECTED) return fail(TEAM_DECLINED);
    await tx.team.update({ where: { id: team.id }, data: { lookingForMembers: looking } });
    return { ok: true };
  });
}

/** Disband: cancels every member registration, deletes the team, frees its unit. */
export async function disbandTeam(auth: TeamLeaderAuth): Promise<TeamResult<{ cancelled: number }>> {
  return teamTransaction(async (tx, webhooks): Promise<TeamResult<{ cancelled: number }>> => {
    const event = await lockEvent(tx, auth.eventId);
    if (!event) return fail(TEAM_NOT_FOUND);
    const team = await lockedLeaderTeam(tx, auth);
    if (!team) return fail(TEAM_NOT_FOUND);
    const checkedIn = await tx.rSVP.count({ where: { teamId: team.id, checkedInAt: { not: null } } });
    if (checkedIn > 0) return fail("Someone in this team has already checked in, so it can't be disbanded.");
    const members = await tx.rSVP.findMany({
      where: { teamId: team.id, eventId: event.id },
      select: { ...rsvpWebhookSnapshotSelect, status: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    // Same set as `members`: every member change takes the Event lock held here.
    const removed = await tx.rSVP.deleteMany({ where: { teamId: team.id, eventId: event.id } });
    await tx.team.delete({ where: { id: team.id } });
    for (const member of members) {
      webhooks.push({ type: "registration.status_changed", rsvpId: member.id, status: "CANCELLED", previousStatus: member.status, snapshot: rsvpWebhookSnapshot(member) });
    }
    if (team.status === RsvpStatus.CONFIRMED) webhooks.push(...((await promoteOldestWaitlistedUnit(tx, event))?.webhooks ?? []));
    return { ok: true, data: { cancelled: removed.count } };
  });
}
