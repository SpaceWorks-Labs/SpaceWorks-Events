import "server-only";

import { EventStatus, RsvpStatus } from "@prisma/client";
import { formatDateBlock, formatDayShort, formatTimeRange } from "@/lib/format/datetime";
import type { AccountPages } from "./accountLimits";
import { canCancelRegistration, registrationStatus, type RegistrationStatusView } from "./accountRegistrations/status";
import { loadAccountRegistrationRecords, type AccountRsvpRow, type NormalisedAccountRegistration } from "./accountRegistrations/records";

export * from "./accountLimits";
export * from "./accountRegistrations/status";
export * from "./accountRegistrations/records";

/* ---------- Account page rows ---------- */

/** Serializable, client-safe row. The ticket token travels only inside `ticketHref`/`cancelToken`, never as display text. */
export type AccountRegistrationRow = {
  id: string;
  title: string;
  organisationName: string;
  dateBlock: { month: string; day: string };
  dateLabel: string;
  timeLabel: string;
  location: string | null;
  isOnline: boolean;
  isSeries: boolean;
  eventCancelled: boolean;
  status: RegistrationStatusView;
  ticketHref: string | null;
  eventHref: string | null;
  /** Present only when the existing cancel action may be offered. */
  cancelToken: string | null;
  /** Team registrations: the team name, and for its leader the signed-in team page. */
  team: { name: string; isLeader: boolean; manageHref: string | null } | null;
  /** Events taking hackathon submissions: the signed-in project page (team or solo). */
  submissionHref: string | null;
};

export type AccountCertificateRow = {
  id: string;
  title: string;
  organisationName: string;
  issuedLabel: string;
  certificateHref: string;
};

function toRow(item: NormalisedAccountRegistration, now: Date): AccountRegistrationRow {
  const { rsvp } = item;
  // Crew tickets (docs/CREW.md) are removed only by the organisers, and never enter a team or project.
  const cancellable = !rsvp.isCrew && canCancelRegistration({ status: rsvp.status, checkedInAt: rsvp.checkedInAt, end: item.end }, now);
  const showTicket = rsvp.status !== RsvpStatus.REJECTED;
  return {
    id: rsvp.id,
    title: item.title,
    organisationName: item.organisationName,
    dateBlock: formatDateBlock(item.start, item.timeZone),
    dateLabel: formatDayShort(item.start, item.timeZone, now),
    timeLabel: formatTimeRange(item.start, item.end, item.timeZone),
    location: item.location,
    isOnline: item.isOnline,
    isSeries: item.isSeries,
    eventCancelled: item.eventStatus === EventStatus.CANCELLED,
    status: rsvp.isCrew && !rsvp.checkedInAt ? { label: "Crew", tone: "success" } : registrationStatus(rsvp.status, rsvp.checkedInAt),
    ticketHref: showTicket ? `/ticket/${rsvp.checkInToken}` : null,
    eventHref: item.eventHref,
    cancelToken: cancellable ? rsvp.checkInToken : null,
    team: rsvp.isCrew ? null : teamView(rsvp),
    submissionHref: rsvp.isCrew ? null : submissionHref(rsvp),
  };
}

/**
 * The project page resolves only for this signed-in account's own
 * registration (`resolveEntrantForUser`); the event id alone grants nothing.
 * Like the page itself, it is offered only while the event is published and
 * its website released.
 */
export function submissionHref(rsvp: {
  status: RsvpStatus;
  event: { id: string; submissionsEnabled: boolean; status: EventStatus; page: { isPublished: boolean } | null } | null;
}): string | null {
  const event = rsvp.event;
  if (!event?.submissionsEnabled || rsvp.status === RsvpStatus.REJECTED) return null;
  if (event.status !== EventStatus.PUBLISHED || event.page?.isPublished !== true) return null;
  return `/account/submissions/${encodeURIComponent(event.id)}`;
}

/** The leader link resolves only for the signed-in leader (`resolveLeaderForUser`); the id alone grants nothing. */
function teamView(rsvp: AccountRsvpRow): AccountRegistrationRow["team"] {
  const team = rsvp.team;
  if (!team) return null;
  const isLeader = team.leaderRsvpId === rsvp.id;
  return { name: team.name, isLeader, manageHref: isLeader ? `/account/teams/${encodeURIComponent(team.id)}` : null };
}

/**
 * The signed-in user's own registrations, one page per section. Every query
 * is keyed on `RSVP.userId` (never an email match) and bounded by the page size.
 */
export async function loadAccountRegistrations(userId: string, now: Date = new Date(), pages: Partial<AccountPages> = {}) {
  const { upcoming, past, certificates, pagination } = await loadAccountRegistrationRecords(userId, now, pages);
  return {
    pagination,
    upcoming: upcoming.map((item) => toRow(item, now)),
    past: past.map((item) => toRow(item, now)),
    certificates: certificates.map((certificate): AccountCertificateRow => ({
      id: certificate.id,
      title: certificate.title,
      organisationName: certificate.organisationName,
      issuedLabel: formatDayShort(certificate.issuedAt, certificate.timeZone, now),
      certificateHref: certificate.certificateHref,
    })),
  };
}
