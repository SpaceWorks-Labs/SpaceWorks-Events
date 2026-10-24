import "server-only";

import { RegistrationMode, SoloPolicy } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  listSeekersForSeeker,
  listTeamsLookingForMembers,
  loadMemberTeamView,
  loadSeekerView,
  type TicketHolder,
} from "@/lib/core/teams";

type TicketRsvp = {
  id: string;
  eventId: string | null;
  userId: string | null;
  teamId: string | null;
  status: string;
  event: { organisationId: string; registrationMode: RegistrationMode; soloPolicy: SoloPolicy; endDateTime: Date; } | null;
};

type SeekerView = NonNullable<Awaited<ReturnType<typeof loadSeekerView>>>;

export type TicketTeamSection =
  | { kind: "member"; team: NonNullable<Awaited<ReturnType<typeof loadMemberTeamView>>>; manageHref: string | null; canLeave: boolean; }
  | {
    /** A solo registrant: join a team with its link, and on matching events list themselves as looking for one. */
    kind: "solo";
    canJoin: boolean;
    seeker: {
      profile: SeekerView["profile"];
      invites: SeekerView["invites"];
      requests: SeekerView["requests"];
      seekers: Awaited<ReturnType<typeof listSeekersForSeeker>>;
      teams: Awaited<ReturnType<typeof listTeamsLookingForMembers>>;
    } | null;
  }
  | { kind: "sign-in" };

/**
 * The ticket page's team section (docs/TEAMS.md). The ticket token identifies a
 * member for viewing their team and for their own leave and seeker actions
 * only; it never grants team management. Like cancellation, an account-owned
 * registration needs that account signed in before anything can change, and
 * the private seeker lists are only shown to someone who can act.
 */
export async function loadTicketTeamSection(rsvp: TicketRsvp, isCheckedIn: boolean): Promise<TicketTeamSection | null> {
  const event = rsvp.event;
  if (!event || event.registrationMode !== RegistrationMode.TEAM || !rsvp.eventId) return null;
  const session = await auth();
  const viewerId = session?.user?.id ?? null;
  const canAct = !rsvp.userId || rsvp.userId === viewerId;
  const holder: TicketHolder = { rsvpId: rsvp.id, eventId: rsvp.eventId, organisationId: event.organisationId, userId: rsvp.userId, teamId: rsvp.teamId };
  if (rsvp.teamId) {
    const team = await loadMemberTeamView(holder);
    if (!team) return null;
    return {
      kind: "member",
      team,
      manageHref: team.isLeader && rsvp.userId && rsvp.userId === viewerId ? `/account/teams/${rsvp.teamId}` : null,
      canLeave: canAct && !isCheckedIn && rsvp.status !== "REJECTED",
    };
  }
  if (rsvp.status === "REJECTED") return null;
  if (!canAct) return { kind: "sign-in" };
  const canJoin = event.endDateTime > new Date();
  if (event.soloPolicy !== SoloPolicy.SOLO_WITH_MATCHING) return canJoin ? { kind: "solo", canJoin, seeker: null } : null;
  const [seekerView, seekers, teams] = await Promise.all([loadSeekerView(holder), listSeekersForSeeker(holder), listTeamsLookingForMembers(holder)]);
  const seeker = seekerView ? { profile: seekerView.profile, invites: seekerView.invites, requests: seekerView.requests, seekers, teams } : null;
  return seeker || canJoin ? { kind: "solo", canJoin, seeker } : null;
}
