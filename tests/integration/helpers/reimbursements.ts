import { randomUUID } from "node:crypto";
import { EventStatus, MembershipRole, RegistrationMode, RsvpStatus, SubmissionStatus, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";
import { savePolicy, type PolicyAdminContext } from "@/lib/claims/policies/manage";

/*
 * Fixtures for the reimbursement policy suites (docs/FINANCE.md
 * "Reimbursement policies"): an organisation with an owner, free one-off
 * events, registrations, teams, projects, judging and mentoring rounds,
 * written directly so each suite controls every eligibility fact.
 */

export const ctx = { suffix: randomUUID().replaceAll("-", ""), organisationId: "", otherOrganisationId: "", ownerId: "", memberId: "", startedAt: new Date() };
let sequence = 0;

export async function setUpReimbursements(label: string) {
  const [org, other] = await Promise.all([
    prisma.organisation.create({ data: { name: `${label} ${ctx.suffix}`, slug: `${label.toLowerCase()}-${ctx.suffix}` } }),
    prisma.organisation.create({ data: { name: `${label} other ${ctx.suffix}`, slug: `${label.toLowerCase()}-other-${ctx.suffix}` } }),
  ]);
  ctx.organisationId = org.id;
  ctx.otherOrganisationId = other.id;
  const [owner, member] = await Promise.all([
    prisma.user.create({ data: { email: `owner-${ctx.suffix}@example.test`, name: "Owner" } }),
    prisma.user.create({ data: { email: `member-${ctx.suffix}@example.test`, name: "Member" } }),
  ]);
  ctx.ownerId = owner.id;
  ctx.memberId = member.id;
  await prisma.membership.create({ data: { userId: owner.id, organisationId: org.id, role: MembershipRole.OWNER } });
  await prisma.membership.create({ data: { userId: member.id, organisationId: org.id, role: MembershipRole.MEMBER } });
}

export async function tearDownReimbursements() {
  await prisma.organisation.deleteMany({ where: { id: { in: [ctx.organisationId, ctx.otherOrganisationId] } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${ctx.suffix}@example.test` } } });
  await prisma.outboxMessage.deleteMany({ where: { createdAt: { gte: ctx.startedAt } } });
}

/** A free, published one-off team event (no ticket types, no currency yet). */
export async function freeEvent(organisationId = ctx.organisationId): Promise<Event> {
  sequence += 1;
  return prisma.event.create({ data: {
    organisationId, title: `Reimburse ${sequence}`, slug: `reimburse-${ctx.suffix}-${sequence}`, timezone: "UTC", status: EventStatus.PUBLISHED,
    startDateTime: new Date(Date.now() - 3_600_000), endDateTime: new Date(Date.now() + 86_400_000), registrationMode: RegistrationMode.TEAM, teamMaxSize: 4, submissionsEnabled: true,
    page: { create: { isPublished: true } },
  } });
}

export const admin = (event: Event, organisationId = ctx.organisationId): PolicyAdminContext => ({ userId: ctx.ownerId, organisationId, eventId: event.id });

/** A confirmed registration (guest), optionally in a team, crew, or checked in. */
export async function person(event: Event, options: { teamId?: string; crew?: boolean; checkedIn?: boolean; status?: RsvpStatus } = {}) {
  sequence += 1;
  const email = `p${sequence}-${ctx.suffix}@example.test`;
  return prisma.rSVP.create({ data: {
    eventId: event.id, guestEmail: email, guestName: `Person ${sequence}`, attendeeKey: `guest:${email}`, status: options.status ?? RsvpStatus.CONFIRMED,
    teamId: options.teamId ?? null, isCrew: options.crew ?? false, checkedInAt: options.checkedIn ? new Date() : null,
  } });
}

export async function team(event: Event, status: RsvpStatus = RsvpStatus.CONFIRMED) {
  sequence += 1;
  return prisma.team.create({ data: { eventId: event.id, name: `Team ${sequence}`, nameKey: `team ${sequence}`, status, joinToken: `join-${ctx.suffix}-${sequence}`, manageTokenHash: `${ctx.suffix}${sequence}`.padEnd(64, "0").slice(0, 64) } });
}

export async function submission(event: Event, entrant: { teamId?: string; rsvpId?: string }, status: SubmissionStatus = SubmissionStatus.SUBMITTED) {
  return prisma.submission.create({ data: { eventId: event.id, teamId: entrant.teamId ?? null, rsvpId: entrant.rsvpId ?? null, title: "Project", status, submittedAt: new Date() } });
}

/** Round 1 (every project) and round 2 "Finals" (advanced projects). */
export async function finalsRound(event: Event) {
  await prisma.judgingRound.create({ data: { eventId: event.id, name: "Round 1", position: 1 } });
  return prisma.judgingRound.create({ data: { eventId: event.id, name: "Finals", position: 2, entrySource: "ADVANCED" } });
}

export async function mentoringRound(event: Event) {
  return prisma.mentoringRound.create({ data: { eventId: event.id, position: 1, label: "Check-in 1", opensAt: event.startDateTime, closesAt: event.endDateTime } });
}

export async function checkIn(event: Event, roundId: string, teamId: string, away = false) {
  return prisma.mentoringCheckIn.create({ data: { eventId: event.id, roundId, teamId, mentorUserId: ctx.ownerId, formSnapshot: [], answers: {}, away, startedAt: new Date(), submittedAt: new Date() } });
}

type PolicyFields = { name?: string; eligibility?: string; crewKinds?: string[]; judgingRoundId?: string; mentoringRoundId?: string; cap?: string; budget?: string; categories?: string[]; attendanceRequired?: boolean; requireFinalistsPublished?: boolean; claimOpensAt?: string; claimClosesAt?: string; notifyWhenAvailable?: boolean; active?: boolean };

export async function policy(event: Event, fields: PolicyFields = {}) {
  const result = await savePolicy(admin(event), { name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", cap: "1000", categories: ["TRAVEL", "ACCOMMODATION"], ...fields });
  if (!result.ok) throw new Error(result.error);
  return result.data.policyId;
}

export function claimInput(amount: string, policyId: string, category = "TRAVEL") {
  return { category, description: "Train fare", amount, policyId };
}
