import "server-only";

import { EventPrivacyType, EventStatus, Prisma, RsvpStatus, SoloPolicy, TeamJoinRequestDirection, TeamJoinRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { teamJoinPath } from "@/lib/teamToken";
import { leaderAuthMatches, personName, type TeamLeaderAuth, type TicketHolder } from "./shared";
import { joinRequestPageQuerySchema, pageJoinRequests, type CursorPage } from "./paging";
import { seekerDisplayName } from "./seekers";

/** A pending invitation or request on the team page: the seeker's display fields only. */
export type TeamJoinRequestItemDto = { id: string; direction: TeamJoinRequestDirection; displayName: string; headline: string | null; skills: string[] };

const teamJoinRequestSelect = {
  id: true,
  direction: true,
  createdAt: true,
  rsvp: { select: { guestName: true, user: { select: { name: true } }, seekerProfile: { select: { headline: true, skills: true } } } },
} satisfies Prisma.TeamJoinRequestSelect;

export function teamJoinRequestDto(request: {
  id: string;
  direction: TeamJoinRequestDirection;
  rsvp: { guestName: string | null; user: { name: string | null } | null; seekerProfile: { headline: string; skills: string[] } | null };
}): TeamJoinRequestItemDto {
  return {
    id: request.id,
    direction: request.direction,
    displayName: seekerDisplayName(request.rsvp.user?.name?.trim() || request.rsvp.guestName),
    headline: request.rsvp.seekerProfile?.headline ?? null,
    skills: request.rsvp.seekerProfile ? [...request.rsvp.seekerProfile.skills] : [],
  };
}

function teamJoinRequestPage(teamId: string, direction: TeamJoinRequestDirection, cursor: string | null | undefined) {
  return pageJoinRequests(
    { teamId, status: TeamJoinRequestStatus.PENDING, direction },
    cursor,
    (args) => prisma.teamJoinRequest.findMany({ ...args, select: teamJoinRequestSelect, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    (row) => teamJoinRequestDto(row),
  );
}

/**
 * Team page "Show more" for incoming requests (`REQUEST`) or sent invitations
 * (`INVITE`). Leader authority is re-checked against the team row on every
 * page; null on any mismatch.
 */
export async function listTeamJoinRequestsForLeader(
  auth: TeamLeaderAuth,
  direction: TeamJoinRequestDirection,
  input: unknown = {},
): Promise<CursorPage<TeamJoinRequestItemDto> | null> {
  const parsed = joinRequestPageQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return null;
  const team = await prisma.team.findFirst({
    where: { id: auth.teamId, eventId: auth.eventId },
    select: { manageTokenHash: true, leaderRsvp: { select: { userId: true } } },
  });
  if (!team || !leaderAuthMatches(auth, team)) return null;
  return teamJoinRequestPage(auth.teamId, direction, parsed.data.cursor);
}

export type TeamPageDto = {
  team: {
    id: string;
    name: string;
    status: RsvpStatus;
    size: number;
    minSize: number | null;
    maxSize: number | null;
    incomplete: boolean;
    lookingForMembers: boolean;
    joinPath: string;
  };
  event: {
    title: string;
    orgSlug: string;
    eventSlug: string;
    startDateTime: Date;
    endDateTime: Date;
    timezone: string;
    registrationOpen: boolean;
    soloPolicy: SoloPolicy;
    /** Invite-only events: the leader can't add members by email, only share the join link. */
    inviteOnly: boolean;
  };
  members: Array<{ rsvpId: string; name: string; isLeader: boolean; checkedIn: boolean }>;
  /** First page of pending requests the team received, seeker side as display fields only. */
  incomingRequests: CursorPage<TeamJoinRequestItemDto>;
  /** First page of pending invitations the team sent. */
  sentInvites: CursorPage<TeamJoinRequestItemDto>;
};

type TeamPageRow = {
  id: string;
  name: string;
  status: RsvpStatus;
  joinToken: string;
  leaderRsvpId: string | null;
  lookingForMembers: boolean;
  event: {
    title: string;
    slug: string;
    startDateTime: Date;
    endDateTime: Date;
    timezone: string;
    teamMinSize: number | null;
    teamMaxSize: number | null;
    soloPolicy: SoloPolicy;
    privacyType: EventPrivacyType;
    registrationOpen: boolean;
    organisation: { slug: string };
  };
  members: Array<{ id: string; guestName: string | null; checkedInAt: Date | null; user: { name: string | null } | null }>;
};

/** Team page DTO: names only for members; no emails, answers, or ticket tokens. */
export function teamPageDto(
  row: TeamPageRow,
  requests: { incoming: CursorPage<TeamJoinRequestItemDto>; sent: CursorPage<TeamJoinRequestItemDto> },
): TeamPageDto {
  const size = row.members.length;
  return {
    team: {
      id: row.id,
      name: row.name,
      status: row.status,
      size,
      minSize: row.event.teamMinSize,
      maxSize: row.event.teamMaxSize,
      incomplete: row.event.teamMinSize != null && size < row.event.teamMinSize,
      lookingForMembers: row.lookingForMembers,
      joinPath: teamJoinPath(row.event.organisation.slug, row.event.slug, row.joinToken),
    },
    event: {
      title: row.event.title,
      orgSlug: row.event.organisation.slug,
      eventSlug: row.event.slug,
      startDateTime: row.event.startDateTime,
      endDateTime: row.event.endDateTime,
      timezone: row.event.timezone,
      registrationOpen: row.event.registrationOpen,
      soloPolicy: row.event.soloPolicy,
      inviteOnly: row.event.privacyType === EventPrivacyType.INVITE_ONLY,
    },
    members: row.members.map((member) => ({
      rsvpId: member.id,
      name: personName(member),
      isLeader: member.id === row.leaderRsvpId,
      checkedIn: member.checkedInAt != null,
    })),
    incomingRequests: requests.incoming,
    sentInvites: requests.sent,
  };
}

/** Load the team page for a leader (manage token or signed-in leader). */
export async function loadTeamPage(auth: TeamLeaderAuth): Promise<TeamPageDto | null> {
  const team = await prisma.team.findFirst({
    where: { id: auth.teamId, eventId: auth.eventId },
    select: {
      id: true,
      name: true,
      status: true,
      joinToken: true,
      manageTokenHash: true,
      leaderRsvpId: true,
      lookingForMembers: true,
      leaderRsvp: { select: { userId: true } },
      event: {
        select: {
          title: true,
          slug: true,
          status: true,
          startDateTime: true,
          endDateTime: true,
          timezone: true,
          registrationClosesAt: true,
          registrationLeadMinutes: true,
          teamMinSize: true,
          teamMaxSize: true,
          soloPolicy: true,
          privacyType: true,
          page: { select: { isPublished: true } },
          organisation: { select: { slug: true } },
        },
      },
      // Bounded by `teamMaxSize`; members are never paged.
      members: {
        select: { id: true, guestName: true, checkedInAt: true, user: { select: { name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!team || !leaderAuthMatches(auth, team)) return null;
  const registrationOpen =
    team.event.status === EventStatus.PUBLISHED &&
    team.event.page?.isPublished === true &&
    team.event.endDateTime > new Date() &&
    !isRegistrationClosed(team.event);
  const [incoming, sent] = await Promise.all([
    teamJoinRequestPage(team.id, TeamJoinRequestDirection.REQUEST, null),
    teamJoinRequestPage(team.id, TeamJoinRequestDirection.INVITE, null),
  ]);
  return teamPageDto({ ...team, event: { ...team.event, registrationOpen } }, { incoming, sent });
}

export type MemberTeamViewDto = { name: string; leaderName: string | null; members: string[]; isLeader: boolean };

/** Ticket page: the holder's team name, leader name and member names only. */
export async function loadMemberTeamView(holder: TicketHolder): Promise<MemberTeamViewDto | null> {
  if (!holder.teamId) return null;
  const team = await prisma.team.findFirst({
    where: { id: holder.teamId, eventId: holder.eventId },
    select: {
      name: true,
      leaderRsvpId: true,
      members: { select: { id: true, guestName: true, user: { select: { name: true } } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!team) return null;
  const leader = team.members.find((member) => member.id === team.leaderRsvpId);
  return {
    name: team.name,
    leaderName: leader ? personName(leader) : null,
    members: team.members.map(personName),
    isLeader: team.leaderRsvpId === holder.rsvpId,
  };
}
