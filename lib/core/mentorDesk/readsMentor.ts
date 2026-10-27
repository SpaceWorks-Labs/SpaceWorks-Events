import "server-only";

/*
 * The mentor console read model: my queue (with eligibility worked out the
 * same way as the claim command), my claim and its comments, my teams, my
 * office-hour slots and the live round's visit board. Reads never mutate.
 * Other mentors' leases, team contact details and other rounds' notes never
 * appear (round_board.project).
 */

import { HelpRequestStatus, MentorAssignmentStatus, MentoringRoundStatus, OfficeHourBookingStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { helpDeadline, inWindows, parseAvailability, skillAndPriorityEligible } from "@/lib/mentorDesk/rules";
import { parseRoundForm } from "@/lib/mentorDesk/roundForm";
import { safeTimeZone, zonedDatetimeLocalValue } from "@/lib/timeZone";
import type { MentorContext } from "./access";

export async function loadMentorConsole(m: MentorContext, now = new Date()) {
  const event = await prisma.event.findFirst({ where: { id: m.eventId, organisationId: m.organisationId, mentorDeskEnabled: true }, select: { id: true, timezone: true, endDateTime: true, startDateTime: true } });
  const profile = event ? await prisma.mentorProfile.findUnique({ where: { eventId_userId: { eventId: event.id, userId: m.userId } } }) : null;
  if (!event || !profile) return null;
  const tz = safeTimeZone(event.timezone);
  const local = (d: Date) => zonedDatetimeLocalValue(d, tz);
  const availability = parseAvailability(profile.availability);
  const liveRound = await prisma.mentoringRound.findFirst({ where: { eventId: event.id, status: MentoringRoundStatus.LIVE }, include: { mentors: { select: { mentorUserId: true } } } });
  const scopeRounds = [null, ...(liveRound ? [liveRound.id] : [])];
  const [open, mine, conflicts, ownRsvps, activeAssignments, slots, categories, teams] = await Promise.all([
    prisma.helpRequest.findMany({ where: { eventId: event.id, status: HelpRequestStatus.OPEN }, orderBy: [{ priority: "desc" }, { createdAt: "asc" }], take: 100, select: { id: true, version: true, teamId: true, rsvpId: true, summary: true, location: true, priority: true, exclusiveUntil: true, expiresAt: true, createdAt: true, category: { select: { label: true, skillTags: true } }, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } } } }),
    prisma.helpRequest.findFirst({ where: { eventId: event.id, status: HelpRequestStatus.CLAIMED, claimedByUserId: m.userId }, select: { id: true, version: true, claimId: true, claimGeneration: true, claimExpiresAt: true, expiresAt: true, summary: true, location: true, category: { select: { label: true } }, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } }, comments: { orderBy: { createdAt: "asc" }, take: 100, select: { id: true, origin: true, body: true, createdAt: true } } } }),
    prisma.mentorConflict.findMany({ where: { eventId: event.id, mentorUserId: m.userId, active: true }, select: { teamId: true, kind: true, reason: true, version: true, team: { select: { name: true } } } }),
    prisma.rSVP.findMany({ where: { eventId: event.id, userId: m.userId }, select: { id: true, teamId: true } }),
    prisma.mentorTeamAssignment.findMany({ where: { eventId: event.id, status: MentorAssignmentStatus.ACTIVE, endedAt: null, activeFrom: { lte: now }, OR: scopeRounds.map((roundId) => ({ roundId })) }, select: { teamId: true, mentorUserId: true, roundId: true, team: { select: { name: true } } } }),
    prisma.officeHourSlot.findMany({ where: { eventId: event.id, mentorUserId: m.userId, endsAt: { gt: now }, cancelledAt: null }, orderBy: { startsAt: "asc" }, select: { id: true, version: true, startsAt: true, endsAt: true, location: true, capacity: true, bookings: { where: { status: OfficeHourBookingStatus.BOOKED }, select: { team: { select: { name: true } } } } } }),
    prisma.helpCategory.findMany({ where: { eventId: event.id, active: true }, orderBy: { position: "asc" }, select: { key: true, label: true } }),
    prisma.team.findMany({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }),
  ]);
  const blocked = new Set([...conflicts.map((c) => c.teamId), ...ownRsvps.flatMap((r) => (r.teamId ? [r.teamId] : []))]);
  const ownRsvpIds = new Set(ownRsvps.map((r) => r.id));
  const assignedBy = new Map<string, Set<string>>();
  for (const a of activeAssignments) assignedBy.set(a.teamId, (assignedBy.get(a.teamId) ?? new Set()).add(a.mentorUserId));
  const who = (r: { team: { name: string } | null; rsvp: { guestName: string | null; user: { name: string | null } | null } | null }) => r.team?.name ?? (r.rsvp?.user?.name?.trim() || r.rsvp?.guestName?.trim() || "Participant");
  // A mentor never sees the text of help from their own team or a team they are conflicted with.
  const queue = open.filter((r) => (r.teamId ? !blocked.has(r.teamId) : !ownRsvpIds.has(r.rsvpId!))).map((r) => {
    const assigned = r.teamId ? assignedBy.get(r.teamId) : undefined;
    const eligible = r.teamId
      ? skillAndPriorityEligible({ assignedToMentor: Boolean(assigned?.has(m.userId)), teamHasAssignedMentor: Boolean(assigned?.size), priorityUntil: r.exclusiveUntil, now, mentorSkills: profile.skills, skillTags: r.category.skillTags })
      : skillAndPriorityEligible({ assignedToMentor: false, teamHasAssignedMentor: false, priorityUntil: null, now, mentorSkills: profile.skills, skillTags: r.category.skillTags });
    return { id: r.id, version: r.version, category: r.category.label, priority: r.priority, summary: r.summary, location: r.location, who: who(r), assignedToMe: Boolean(assigned?.has(m.userId)), eligible, deadline: helpDeadline(r.expiresAt, event.endDateTime).toISOString(), createdAt: r.createdAt.toISOString() };
  });
  let board: Array<{ teamId: string; teamName: string; state: "due" | "seen" | "busy" | "done" | "conflict" }> | null = null;
  let leaseFor: Record<string, { leaseId: string; generation: number; version: number; expiresAt: string }> = {};
  if (liveRound) {
    const [checkIns, seen, leases] = await Promise.all([
      prisma.mentoringCheckIn.findMany({ where: { roundId: liveRound.id }, select: { teamId: true } }),
      prisma.mentoringCheckIn.findMany({ where: { eventId: event.id, mentorUserId: m.userId }, select: { teamId: true } }),
      prisma.mentoringVisit.findMany({ where: { roundId: liveRound.id, expiresAt: { gt: now } }, select: { teamId: true, mentorUserId: true, leaseId: true, generation: true, version: true, expiresAt: true } }),
    ]);
    const done = new Set(checkIns.map((c) => c.teamId));
    const seenSet = new Set(seen.map((c) => c.teamId));
    const leaseBy = new Map(leases.map((l) => [l.teamId, l]));
    board = teams.map((t) => ({ teamId: t.id, teamName: t.name, state: done.has(t.id) ? "done" : blocked.has(t.id) ? "conflict" : leaseBy.has(t.id) ? "busy" : seenSet.has(t.id) ? "seen" : "due" }));
    // Only my own lease secrets are returned.
    leaseFor = Object.fromEntries(leases.filter((l) => l.mentorUserId === m.userId).map((l) => [l.teamId, { leaseId: l.leaseId, generation: l.generation, version: l.version, expiresAt: l.expiresAt.toISOString() }]));
  }
  return {
    timezone: tz,
    onShift: inWindows(availability, now),
    profile: { version: profile.version, skills: profile.skills, bio: profile.bio, affiliation: profile.affiliation, maxActiveTeams: profile.maxActiveTeams, showOnPage: profile.showOnPage, availability: availability.map((w) => ({ start: local(new Date(w.startsAt)), end: local(new Date(w.endsAt)) })), eventStart: local(event.startDateTime), eventEnd: local(event.endDateTime) },
    queue,
    claim: mine ? { id: mine.id, version: mine.version, claimId: mine.claimId!, claimGeneration: mine.claimGeneration, claimExpiresAt: mine.claimExpiresAt!.toISOString(), lapsed: mine.claimExpiresAt! <= now, category: mine.category.label, summary: mine.summary, location: mine.location, who: who(mine), comments: mine.comments.map((c) => ({ id: c.id, origin: c.origin, body: c.body, createdAt: c.createdAt.toISOString() })) } : null,
    myTeams: activeAssignments.filter((a) => a.mentorUserId === m.userId).map((a) => ({ teamId: a.teamId, teamName: a.team.name, roundId: a.roundId })),
    conflicts: conflicts.map((c) => ({ teamId: c.teamId, teamName: c.team.name, kind: c.kind, reason: c.reason })),
    slots: slots.map((s) => ({ id: s.id, version: s.version, startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), start: local(s.startsAt), end: local(s.endsAt), location: s.location, capacity: s.capacity, teams: s.bookings.map((b) => b.team.name) })),
    categories,
    teams,
    round: liveRound && board ? {
      id: liveRound.id, version: liveRound.version, label: liveRound.label, formVersion: liveRound.formVersion, closesAt: liveRound.closesAt.toISOString(),
      inPool: liveRound.mentors.length === 0 || liveRound.mentors.some((x) => x.mentorUserId === m.userId),
      allowFreshEyesOverride: liveRound.allowFreshEyesOverride, allowConflictOverride: liveRound.allowConflictOverride,
      form: parseRoundForm(liveRound.formSchema), board, leases: leaseFor,
    } : null,
  };
}

export type MentorConsoleView = NonNullable<Awaited<ReturnType<typeof loadMentorConsole>>>;
