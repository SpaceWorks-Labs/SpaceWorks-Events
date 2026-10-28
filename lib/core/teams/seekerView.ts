import "server-only";

import { Prisma, RsvpStatus, TeamJoinRequestDirection, TeamJoinRequestStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isMatchingEvent, type TicketHolder } from "./shared";
import { joinRequestPageQuerySchema, pageJoinRequests, type CursorPage } from "./paging";

/** A pending invitation from a team, to accept or decline: team name and size only. */
export type SeekerInviteDto = { id: string; teamName: string; size: number; maxSize: number | null };
/** A pending request the holder sent, to withdraw. */
export type SeekerRequestDto = { id: string; teamId: string; teamName: string };

export type SeekerViewDto = {
  /** The holder's own profile, including hidden ones, so it can be edited. */
  profile: { headline: string; skills: string[]; visible: boolean } | null;
  /** First page of pending invitations from teams. */
  invites: CursorPage<SeekerInviteDto>;
  /** First page of pending requests the holder sent. */
  requests: CursorPage<SeekerRequestDto>;
};

/** Seeker-view gate: a solo, non-declined registrant of a matching event (listed or not). */
async function seekerViewHolder(holder: TicketHolder) {
  const rsvp = await prisma.rSVP.findFirst({
    where: { id: holder.rsvpId, eventId: holder.eventId, teamId: null, isCrew: false, status: { not: RsvpStatus.REJECTED } },
    select: {
      seekerProfile: { select: { headline: true, skills: true, visible: true } },
      event: { select: { registrationMode: true, soloPolicy: true, teamMaxSize: true } },
    },
  });
  return rsvp?.event && isMatchingEvent(rsvp.event) ? { profile: rsvp.seekerProfile, maxSize: rsvp.event.teamMaxSize } : null;
}

function seekerJoinRequestWhere(holder: TicketHolder, direction: TeamJoinRequestDirection): Prisma.TeamJoinRequestWhereInput {
  return { rsvpId: holder.rsvpId, status: TeamJoinRequestStatus.PENDING, direction, team: { eventId: holder.eventId } };
}

function seekerInvitePage(holder: TicketHolder, maxSize: number | null, cursor: string | null | undefined) {
  return pageJoinRequests(
    seekerJoinRequestWhere(holder, TeamJoinRequestDirection.INVITE),
    cursor,
    (args) =>
      prisma.teamJoinRequest.findMany({
        ...args,
        select: { id: true, createdAt: true, team: { select: { name: true, _count: { select: { members: true } } } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    (row): SeekerInviteDto => ({ id: row.id, teamName: row.team.name, size: row.team._count.members, maxSize }),
  );
}

function seekerRequestPage(holder: TicketHolder, cursor: string | null | undefined) {
  return pageJoinRequests(
    seekerJoinRequestWhere(holder, TeamJoinRequestDirection.REQUEST),
    cursor,
    (args) =>
      prisma.teamJoinRequest.findMany({
        ...args,
        select: { id: true, createdAt: true, team: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    (row): SeekerRequestDto => ({ id: row.id, teamId: row.team.id, teamName: row.team.name }),
  );
}

/**
 * Ticket page, solo registrant of a SOLO_WITH_MATCHING event: their own
 * profile and the first page of their pending invitations and requests. Team
 * names and sizes only; never member names, emails, or tokens. Null when the
 * holder is in a team, was declined, or the event has no matching list.
 */
export async function loadSeekerView(holder: TicketHolder): Promise<SeekerViewDto | null> {
  const seeker = await seekerViewHolder(holder);
  if (!seeker) return null;
  const [invites, requests] = await Promise.all([seekerInvitePage(holder, seeker.maxSize, null), seekerRequestPage(holder, null)]);
  return {
    profile: seeker.profile ? { headline: seeker.profile.headline, skills: [...seeker.profile.skills], visible: seeker.profile.visible } : null,
    invites,
    requests,
  };
}

/** Ticket page "Show more" for the holder's pending invitations; same gate as `loadSeekerView`. */
export async function listSeekerInvites(holder: TicketHolder, input: unknown = {}): Promise<CursorPage<SeekerInviteDto> | null> {
  const parsed = joinRequestPageQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return null;
  const seeker = await seekerViewHolder(holder);
  return seeker ? seekerInvitePage(holder, seeker.maxSize, parsed.data.cursor) : null;
}

/** Ticket page "Show more" for the holder's pending requests; same gate as `loadSeekerView`. */
export async function listSeekerRequests(holder: TicketHolder, input: unknown = {}): Promise<CursorPage<SeekerRequestDto> | null> {
  const parsed = joinRequestPageQuerySchema.safeParse(input ?? {});
  if (!parsed.success) return null;
  const seeker = await seekerViewHolder(holder);
  return seeker ? seekerRequestPage(holder, parsed.data.cursor) : null;
}
