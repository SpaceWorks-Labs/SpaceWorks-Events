import "server-only";

/*
 * The organiser's Mentor Desk read model (dashboard Mentors tab). Reads never
 * mutate: a lapsed claim shows as lapsed until the beat or a command acts.
 * Organisers see request text; contact details stay out (mentor emails are
 * shown, as in the collaborator list). Dates are ISO strings.
 */

import { EventPermission, HelpRequestStatus, MentorAssignmentStatus, OfficeHourBookingStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { helpDeadline, inWindows, parseAvailability } from "@/lib/mentorDesk/rules";
import { parseRoundForm, parseTriggerRules } from "@/lib/mentorDesk/roundForm";
import { safeTimeZone, zonedDatetimeLocalValue } from "@/lib/timeZone";
import type { DeskOrganiserContext } from "./access";

const QUEUE_LIMIT = 200;

export type DeskRequestDto = {
  id: string; version: number; status: HelpRequestStatus; origin: string; category: string; priority: number;
  summary: string; location: string; who: string; claimedBy: string | null; claimedByUserId: string | null;
  claimExpiresAt: string | null; deadline: string; createdAt: string; rating: number | null; lapsed: boolean;
};

function personLabel(rsvp: { guestName: string | null; user: { name: string | null } | null } | null) {
  return rsvp?.user?.name?.trim() || rsvp?.guestName?.trim() || "Participant";
}

export async function loadDeskOrganiserView(ctx: DeskOrganiserContext, now = new Date()) {
  const event = await prisma.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, timezone: true, startDateTime: true, endDateTime: true, mentorDeskEnabled: true, mentorHelpClaimedEmail: true } });
  if (!event) return null;
  const tz = safeTimeZone(event.timezone);
  const local = (d: Date) => zonedDatetimeLocalValue(d, tz);
  const [grants, categories, queue, assignments, runs, slots, rounds, teams, nominations] = await Promise.all([
    prisma.eventCollaborator.findMany({ where: { eventId: event.id, permissions: { has: EventPermission.MENTOR } }, select: { userId: true, user: { select: { name: true, email: true, mentorProfiles: { where: { eventId: event.id } } } } }, orderBy: { createdAt: "asc" } }),
    prisma.helpCategory.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" } }),
    prisma.helpRequest.findMany({
      where: { eventId: event.id },
      orderBy: [{ status: "asc" }, { priority: "desc" }, { createdAt: "asc" }],
      take: QUEUE_LIMIT,
      select: { id: true, version: true, status: true, origin: true, priority: true, summary: true, location: true, claimedByUserId: true, claimExpiresAt: true, expiresAt: true, createdAt: true, rating: true,
        category: { select: { label: true } }, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } }, claimedBy: { select: { name: true } } },
    }),
    prisma.mentorTeamAssignment.findMany({ where: { eventId: event.id }, orderBy: [{ endedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }], take: 300, select: { id: true, version: true, status: true, mode: true, manualOverride: true, roundId: true, teamId: true, mentorUserId: true, team: { select: { name: true } }, mentor: { select: { name: true } } } }),
    prisma.mentorAssignmentRun.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "desc" }, take: 10, select: { id: true, mode: true, seed: true, roundId: true, uncoveredTeamIds: true, createdAt: true, decisions: true } }),
    prisma.officeHourSlot.findMany({ where: { eventId: event.id }, orderBy: { startsAt: "asc" }, take: 300, select: { id: true, version: true, mentorUserId: true, startsAt: true, endsAt: true, location: true, capacity: true, cancelledAt: true, mentor: { select: { name: true } }, bookings: { where: { status: OfficeHourBookingStatus.BOOKED }, select: { id: true, team: { select: { name: true } } } } } }),
    prisma.mentoringRound.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, include: { mentors: { select: { mentorUserId: true } }, _count: { select: { checkIns: true } } } }),
    prisma.team.findMany({ where: { eventId: event.id, status: RsvpStatus.CONFIRMED }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 }),
    prisma.mentorNomination.groupBy({ by: ["roundId", "teamId"], where: { eventId: event.id }, _count: { _all: true } }),
  ]);
  const loads = new Map<string, number>();
  for (const a of assignments) if (a.status !== MentorAssignmentStatus.ENDED) loads.set(a.mentorUserId, (loads.get(a.mentorUserId) ?? 0) + 1);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const mentors = grants.map((g) => {
    const profile = g.user.mentorProfiles[0];
    const availability = parseAvailability(profile?.availability);
    return {
      userId: g.userId, name: g.user.name?.trim() || "Mentor", email: g.user.email ?? "",
      profile: profile ? { version: profile.version, skills: profile.skills, bio: profile.bio, affiliation: profile.affiliation, maxActiveTeams: profile.maxActiveTeams, showOnPage: profile.showOnPage, availability: availability.map((w) => ({ start: local(new Date(w.startsAt)), end: local(new Date(w.endsAt)) })) } : null,
      onShift: inWindows(availability, now),
      load: loads.get(g.userId) ?? 0,
    };
  });
  const requests: DeskRequestDto[] = queue.map((r) => ({
    id: r.id, version: r.version, status: r.status, origin: r.origin, category: r.category.label, priority: r.priority, summary: r.summary, location: r.location,
    who: r.team?.name ?? personLabel(r.rsvp), claimedBy: r.claimedBy?.name?.trim() || (r.claimedByUserId ? "Mentor" : null), claimedByUserId: r.claimedByUserId,
    claimExpiresAt: r.claimExpiresAt?.toISOString() ?? null, deadline: helpDeadline(r.expiresAt, event.endDateTime).toISOString(), createdAt: r.createdAt.toISOString(), rating: r.rating,
    lapsed: r.status === HelpRequestStatus.CLAIMED && Boolean(r.claimExpiresAt && r.claimExpiresAt <= now),
  }));
  const shortlist = new Map<string, Array<{ teamId: string; teamName: string; nominations: number }>>();
  for (const n of nominations) {
    const list = shortlist.get(n.roundId) ?? [];
    list.push({ teamId: n.teamId, teamName: teamName.get(n.teamId) ?? "Team", nominations: n._count._all });
    shortlist.set(n.roundId, list);
  }
  return {
    settings: { mentorDeskEnabled: event.mentorDeskEnabled, mentorHelpClaimedEmail: event.mentorHelpClaimedEmail, timezone: tz, eventStart: local(event.startDateTime), eventEnd: local(event.endDateTime) },
    mentors,
    categories: categories.map((c) => ({ id: c.id, version: c.version, key: c.key, label: c.label, skillTags: c.skillTags, priority: c.priority, openLimit: c.openLimit, claimMinutes: c.claimMinutes, expiryMinutes: c.expiryMinutes, contactNote: c.contactNote, active: c.active })),
    requests,
    assignments: assignments.map((a) => ({ id: a.id, version: a.version, status: a.status, mode: a.mode, manualOverride: a.manualOverride, roundId: a.roundId, teamId: a.teamId, teamName: a.team.name, mentorUserId: a.mentorUserId, mentorName: a.mentor.name?.trim() || "Mentor" })),
    runs: runs.map((r) => ({ id: r.id, mode: r.mode, seed: r.seed, roundId: r.roundId, uncovered: r.uncoveredTeamIds.length, assigned: Array.isArray(r.decisions) ? r.decisions.length : 0, createdAt: r.createdAt.toISOString() })),
    slots: slots.map((s) => ({ id: s.id, version: s.version, mentorUserId: s.mentorUserId, mentorName: s.mentor.name?.trim() || "Mentor", startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString(), start: local(s.startsAt), end: local(s.endsAt), location: s.location, capacity: s.capacity, cancelled: Boolean(s.cancelledAt), bookings: s.bookings.map((b) => ({ id: b.id, teamName: b.team.name })) })),
    rounds: rounds.map((r) => ({
      id: r.id, version: r.version, position: r.position, label: r.label, status: r.status, opensAt: r.opensAt.toISOString(), closesAt: r.closesAt.toISOString(), opens: local(r.opensAt), closes: local(r.closesAt),
      formSchema: parseRoundForm(r.formSchema), helpTriggerRules: parseTriggerRules(r.helpTriggerRules), allowFreshEyesOverride: r.allowFreshEyesOverride, allowConflictOverride: r.allowConflictOverride, freshEyesAcrossStages: r.freshEyesAcrossStages,
      pool: r.mentors.map((m) => m.mentorUserId), checkIns: r._count.checkIns,
      // Private advisory shortlist: never part of judging scores.
      shortlist: (shortlist.get(r.id) ?? []).sort((a, b) => b.nominations - a.nominations || a.teamName.localeCompare(b.teamName)),
    })),
    teams,
  };
}

export type DeskOrganiserView = NonNullable<Awaited<ReturnType<typeof loadDeskOrganiserView>>>;
