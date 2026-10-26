import "server-only";

import { EventPrivacyType, RegistrationMode, RsvpStatus, SoloPolicy, TeamTicketMode, type Prisma } from "@prisma/client";
import { enqueueTeamCreated } from "@/lib/outbox";
import { noticeEach, noticeSubject, personEmail } from "@/lib/notices";
import { LEADER_STILL_PAYING, TeamRegistrationError } from "@/lib/rsvpCore/team";
import { assignTeamLeaderTx, countConfirmedUnits, settleTeamAfterMemberLeft, teamPlacesTaken } from "@/lib/teamUnits";
import { generateTeamManageToken, generateTeamToken } from "@/lib/teamToken";
import { teamNameKey, type TeamRegistrationIntent } from "@/lib/validators";

/**
 * Tickets on TEAM events (docs/TEAMS.md). Every order seats one person: a
 * solo unit, the leader of a new team, or, when everyone pays for themselves
 * (PER_MEMBER), a member paying to join a team. The money is taken first:
 *
 * - A leader's team is created with the order, PENDING_PAYMENT like its one
 *   registration (so "member status = team status" holds), and takes a unit
 *   while the hold lasts. Nobody can join it until it is paid.
 * - A member paying to join has no team until the payment lands
 *   (`Order.teamId` says which); the hold keeps their place in the team.
 * - Once paid, the place is confirmed, or waits for approval on an
 *   approval-required event. Paid units never wait on the waitlist.
 */

type Seeker = { headline: string; skills: string[]; };

export type TeamOrderPlan =
  | { kind: "solo"; mode: TeamTicketMode; unitsLeft: number | null; seeker: Seeker | null; }
  | { kind: "create"; mode: TeamTicketMode; unitsLeft: number | null; name: string; nameKey: string; }
  | { kind: "join"; mode: TeamTicketMode; unitsLeft: null; team: { id: string; name: string; status: RsvpStatus; }; };

/** Plan a ticket order on a TEAM event under its Event lock; null for other events. */
export async function planTeamOrder(tx: Prisma.TransactionClient, params: {
  eventId: string;
  intent: TeamRegistrationIntent | undefined;
  /** An organiser adding a guest: solo is allowed even on a teams-only event. */
  manual: boolean;
  now: Date;
}): Promise<TeamOrderPlan | null> {
  const event = await tx.event.findUnique({
    where: { id: params.eventId },
    select: { registrationMode: true, capacity: true, teamMaxSize: true, soloPolicy: true, teamTicketMode: true },
  });
  const intent = params.intent;
  if (!event || event.registrationMode !== RegistrationMode.TEAM) {
    if (intent && intent.mode !== "solo") throw new TeamRegistrationError("This event does not use team registration.");
    return null;
  }
  const mode = event.teamTicketMode;
  const unitsLeft = event.capacity == null ? null : event.capacity - await countConfirmedUnits(tx, params.eventId, params.now);
  if (!intent || intent.mode === "solo") {
    if (event.soloPolicy === SoloPolicy.TEAMS_ONLY && !params.manual) {
      throw new TeamRegistrationError("This event registers teams only. Create a team or join one with a team link.", "TEAM_REQUIRED");
    }
    const seeker = intent?.mode === "solo" && intent.seeker && event.soloPolicy === SoloPolicy.SOLO_WITH_MATCHING ? intent.seeker : null;
    return { kind: "solo", mode, unitsLeft, seeker };
  }
  if (intent.mode === "create") {
    const nameKey = teamNameKey(intent.name);
    // An unpaid team keeps its name only while its leader's hold lasts.
    await tx.team.deleteMany({ where: { eventId: params.eventId, nameKey, status: RsvpStatus.PENDING_PAYMENT, members: { none: { holdExpiresAt: { gt: params.now } } } } });
    const taken = await tx.team.findUnique({ where: { eventId_nameKey: { eventId: params.eventId, nameKey } }, select: { id: true } });
    if (taken) throw new TeamRegistrationError("That team name is already taken for this event.");
    return { kind: "create", mode, unitsLeft, name: intent.name, nameKey };
  }
  const team = await tx.team.findFirst({ where: { joinToken: intent.joinToken, eventId: params.eventId }, select: { id: true, name: true, status: true } });
  if (!team) throw new TeamRegistrationError("This team link is no longer valid. Ask your team leader for a new one.");
  if (team.status === RsvpStatus.REJECTED) throw new TeamRegistrationError("This team can no longer be joined.");
  if (team.status === RsvpStatus.PENDING_PAYMENT) throw new TeamRegistrationError(LEADER_STILL_PAYING);
  if (mode === TeamTicketMode.PER_TEAM) throw new TeamRegistrationError("Joining this team is free: its leader paid for the whole team.");
  if (event.teamMaxSize == null || await teamPlacesTaken(tx, team.id, params.now) >= event.teamMaxSize) throw new TeamRegistrationError("This team is already full.");
  return { kind: "join", mode, unitsLeft: null, team };
}

/**
 * After the order's one registration is created: a leader's order creates
 * and leads the team in that registration's status; a free join puts the
 * member in at once, a paid one when the payment lands. The team page link
 * is emailed once the team is paid for (settlement rotates the token).
 */
export async function placeTeamOrderRegistration(tx: Prisma.TransactionClient, plan: TeamOrderPlan, params: {
  eventId: string;
  orderId: string;
  rsvpId: string;
  status: RsvpStatus;
  email: string;
}): Promise<{ teamId: string | null; teamName: string | null; }> {
  if (plan.kind === "solo") {
    if (plan.seeker) await tx.teamSeekerProfile.create({ data: { rsvpId: params.rsvpId, headline: plan.seeker.headline, skills: plan.seeker.skills, visible: true } });
    return { teamId: null, teamName: null };
  }
  if (plan.kind === "create") {
    const manage = generateTeamManageToken();
    const team = await tx.team.create({
      data: { eventId: params.eventId, name: plan.name, nameKey: plan.nameKey, status: params.status, joinToken: generateTeamToken(), manageTokenHash: manage.hash, leaderRsvpId: params.rsvpId },
      select: { id: true },
    });
    await tx.rSVP.update({ where: { id: params.rsvpId }, data: { teamId: team.id } });
    await tx.order.update({ where: { id: params.orderId }, data: { teamId: team.id, teamName: plan.name } });
    if (params.status !== RsvpStatus.PENDING_PAYMENT) await enqueueTeamCreated(tx, { to: params.email, teamId: team.id, manageToken: manage.raw, reason: "created" });
    return { teamId: team.id, teamName: plan.name };
  }
  await tx.order.update({ where: { id: params.orderId }, data: { teamId: plan.team.id } });
  if (params.status !== RsvpStatus.PENDING_PAYMENT) await tx.rSVP.update({ where: { id: params.rsvpId }, data: { teamId: plan.team.id } });
  return { teamId: plan.team.id, teamName: plan.team.name };
}

type TeamOrderRow = { id: string; eventId: string | null; teamId: string | null; teamName: string | null; };

/**
 * Settling a paid order on a TEAM event (the event row is locked): where its
 * registration goes. Null for other orders; "gone" when the place was lost
 * (the hold ended and the unit or team place was taken, or the team was
 * rejected or removed), so the payment is refunded instead.
 */
export async function placePaidTeamOrder(tx: Prisma.TransactionClient, order: TeamOrderRow, rsvpId: string, holdActive: boolean, now: Date): Promise<{ status: RsvpStatus; teamName: string | null; } | "gone" | null> {
  if (!order.eventId) return null;
  const eventId = order.eventId;
  const event = await tx.event.findUnique({ where: { id: eventId }, select: { registrationMode: true, privacyType: true, capacity: true, teamMaxSize: true } });
  if (event?.registrationMode !== RegistrationMode.TEAM) return null;
  const placed = event.privacyType === EventPrivacyType.APPROVAL_REQUIRED ? RsvpStatus.PENDING_APPROVAL : RsvpStatus.CONFIRMED;
  // A unit is only taken by a confirmed place; the hold kept one free until now.
  const unitFree = async () => placed !== RsvpStatus.CONFIRMED || holdActive || event.capacity == null || await countConfirmedUnits(tx, eventId, now) < event.capacity;
  if (order.teamName != null) {
    const team = order.teamId ? await tx.team.findFirst({ where: { id: order.teamId, eventId, status: RsvpStatus.PENDING_PAYMENT }, select: { id: true, name: true } }) : null;
    if (!team || !(await unitFree())) return "gone";
    await tx.team.update({ where: { id: team.id }, data: { status: placed } });
    await assignTeamLeaderTx(tx, { teamId: team.id, leaderRsvpId: rsvpId, reason: "created" });
    return { status: placed, teamName: team.name };
  }
  if (order.teamId) {
    const team = await tx.team.findFirst({ where: { id: order.teamId, eventId }, select: { id: true, name: true, status: true } });
    if (!team || team.status === RsvpStatus.REJECTED || team.status === RsvpStatus.PENDING_PAYMENT) return "gone";
    if (!holdActive && (event.teamMaxSize == null || await teamPlacesTaken(tx, team.id, now) >= event.teamMaxSize)) return "gone";
    await tx.rSVP.update({ where: { id: rsvpId }, data: { teamId: team.id } });
    return { status: team.status, teamName: team.name };
  }
  return (await unitFree()) ? { status: placed, teamName: null } : "gone";
}

/** A leader's hold ended unpaid: the team (only ever the leader) goes, freeing its name. */
export async function releaseUnpaidTeam(tx: Prisma.TransactionClient, orderId: string) {
  await tx.team.deleteMany({ where: { status: RsvpStatus.PENDING_PAYMENT, orders: { some: { id: orderId, teamName: { not: null } } } } });
}

export type CancelledRegistration = { id: string; eventId: string | null; eventInstanceId: string | null; userId: string | null; guestName: string | null; createdAt: Date; checkedInAt: Date | null; status: RsvpStatus; };

const CANCELLED_SELECT = { id: true, eventId: true, eventInstanceId: true, userId: true, guestName: true, createdAt: true, checkedInAt: true, status: true, teamId: true, guestEmail: true, user: { select: { email: true } } } as const;

/**
 * Before an order's registrations are deleted (cancelled, usually with a
 * refund). On a TEAM event a PER_TEAM leader's order takes the whole team
 * with it, since its members joined on that payment; any other member leaves
 * their team as if they had cancelled (leadership passes on, an empty team
 * goes). Returns the other registrations it deleted, for webhooks; refuses
 * when one of them has checked in.
 */
export async function releaseTeamPlacesForCancelledOrder(tx: Prisma.TransactionClient, order: TeamOrderRow): Promise<CancelledRegistration[] | { error: string; }> {
  if (!order.eventId) return [];
  const event = await tx.event.findUnique({ where: { id: order.eventId }, select: { registrationMode: true, teamTicketMode: true, title: true, organisationId: true } });
  if (event?.registrationMode !== RegistrationMode.TEAM) return [];
  const own = await tx.rSVP.findMany({ where: { orderId: order.id }, select: CANCELLED_SELECT });
  if (order.teamName != null && order.teamId && event.teamTicketMode === TeamTicketMode.PER_TEAM) {
    const members = await tx.rSVP.findMany({ where: { teamId: order.teamId, eventId: order.eventId, OR: [{ orderId: null }, { orderId: { not: order.id } }] }, select: CANCELLED_SELECT });
    if (members.some((member) => member.checkedInAt)) return { error: "Someone in this team has checked in, so its team ticket can't be cancelled." };
    await tx.rSVP.deleteMany({ where: { id: { in: members.map((member) => member.id) } } });
    await tx.team.deleteMany({ where: { id: order.teamId } });
    const emails = [...new Set(members.flatMap((member) => personEmail(member) ?? []))];
    await noticeEach(tx, emails, {
      organisationId: event.organisationId,
      subject: noticeSubject("Cancelled", event.title),
      lines: [`The team ticket for ${order.teamName} was cancelled, so your place at ${event.title} is cancelled too. Your ticket no longer works.`, "Register again from the event page if places are still open."],
    });
    return members;
  }
  for (const rsvp of own) {
    if (rsvp.teamId) await settleTeamAfterMemberLeft(tx, { teamId: rsvp.teamId, eventId: order.eventId, leftRsvpId: rsvp.id });
  }
  return [];
}

/** Whether any of these registrations came from an order that cost money (team actions can't delete those: they are cancelled as an order, with a refund). */
export async function hasPaidOrder(tx: Prisma.TransactionClient, where: Prisma.RSVPWhereInput) {
  return (await tx.rSVP.count({ where: { ...where, order: { totalMinor: { gt: 0 } } } })) > 0;
}

export const PAID_MEMBER_REFUSAL = "Someone here paid for their ticket. Paid tickets are cancelled from the order page, or by the organiser under Guests → Payment, with a refund.";

/** Paid orders behind a team's members, refunded in full when the organiser rejects the team. */
export async function paidOrdersOfTeam(tx: Prisma.TransactionClient, teamId: string) {
  const rows = await tx.rSVP.findMany({ where: { teamId, orderId: { not: null }, order: { totalMinor: { gt: 0 } } }, select: { orderId: true }, distinct: ["orderId"] });
  return rows.flatMap((row) => (row.orderId ? [row.orderId] : []));
}

/** Whether this registration's order paid for its whole team (a PER_TEAM leader's team ticket). */
export async function leadsPaidTeam(tx: Prisma.TransactionClient, rsvpId: string) {
  const rsvp = await tx.rSVP.findUnique({ where: { id: rsvpId }, select: { order: { select: { teamName: true, totalMinor: true } }, event: { select: { teamTicketMode: true } } } });
  return rsvp?.order?.teamName != null && rsvp.order.totalMinor > BigInt(0) && rsvp.event?.teamTicketMode === TeamTicketMode.PER_TEAM;
}
