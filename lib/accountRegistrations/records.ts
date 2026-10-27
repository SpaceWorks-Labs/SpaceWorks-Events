import "server-only";

import { EventPrivacyType, type EventStatus, Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sqlUtcTimestamp } from "@/lib/sqlTimestamp";
import { safeTimeZone } from "@/lib/timeZone";
import {
  ACCOUNT_CERTIFICATES_LIMIT,
  ACCOUNT_REGISTRATIONS_LIMIT,
  accountSectionPagination,
  type AccountPages,
} from "../accountLimits";
import { isEventPageReachable } from "./status";

/* ---------- Data loading ---------- */

const eventSelect = {
  id: true,
  title: true,
  slug: true,
  startDateTime: true,
  endDateTime: true,
  timezone: true,
  location: true,
  isOnline: true,
  status: true,
  privacyType: true,
  // Hackathon events (docs/HACKATHON.md): whether to link the entrant's project page.
  submissionsEnabled: true,
  page: { select: { isPublished: true } },
  organisation: { select: { name: true, slug: true } },
} satisfies Prisma.EventSelect;

const instanceSelect = {
  id: true,
  startDateTime: true,
  endDateTime: true,
  series: {
    select: {
      id: true,
      title: true,
      timezone: true,
      status: true,
      privacyType: true,
      organisation: { select: { name: true, slug: true } },
    },
  },
} satisfies Prisma.EventInstanceSelect;

const rsvpSelect = {
  id: true,
  status: true,
  checkedInAt: true,
  checkInToken: true,
  // Team events (docs/TEAMS.md): the name, and whether this registration leads it.
  team: { select: { id: true, name: true, leaderRsvpId: true } },
  event: { select: eventSelect },
  eventInstance: { select: instanceSelect },
} satisfies Prisma.RSVPSelect;

export type AccountRsvpRow = Prisma.RSVPGetPayload<{ select: typeof rsvpSelect }>;

export type NormalisedAccountRegistration = {
  rsvp: AccountRsvpRow;
  title: string;
  organisationName: string;
  start: Date;
  end: Date;
  timeZone: string;
  location: string | null;
  isOnline: boolean;
  isSeries: boolean;
  eventStatus: EventStatus;
  eventHref: string | null;
};

function normalise(rsvp: AccountRsvpRow, invitedEventIds: Set<string>, invitedSeriesIds: Set<string>): NormalisedAccountRegistration | null {
  if (rsvp.event) {
    const event = rsvp.event;
    const reachable = isEventPageReachable({
      status: event.status,
      privacyType: event.privacyType,
      websiteReleased: event.page?.isPublished ?? false,
      invited: invitedEventIds.has(event.id),
    });
    return {
      rsvp,
      title: event.title,
      organisationName: event.organisation.name,
      start: event.startDateTime,
      end: event.endDateTime,
      timeZone: safeTimeZone(event.timezone),
      location: event.location.trim() || null,
      isOnline: event.isOnline,
      isSeries: false,
      eventStatus: event.status,
      eventHref: reachable ? `/${event.organisation.slug}/${event.slug}` : null,
    };
  }
  if (rsvp.eventInstance) {
    const instance = rsvp.eventInstance;
    const series = instance.series;
    const reachable = isEventPageReachable({
      status: series.status,
      privacyType: series.privacyType,
      websiteReleased: true,
      invited: invitedSeriesIds.has(series.id),
    });
    return {
      rsvp,
      title: series.title,
      organisationName: series.organisation.name,
      start: instance.startDateTime,
      end: instance.endDateTime,
      timeZone: safeTimeZone(series.timezone),
      location: null,
      isOnline: false,
      isSeries: true,
      eventStatus: series.status,
      eventHref: reachable ? `/${series.organisation.slug}/i/${instance.id}` : null,
    };
  }
  return null;
}

export type AccountCertificateRecord = {
  id: string;
  title: string;
  organisationName: string;
  issuedAt: Date;
  timeZone: string;
  certificateHref: string;
};

const REGISTRATION_FROM = Prisma.sql`"RSVP" r
  LEFT JOIN "Event" e ON e."id" = r."eventId"
  LEFT JOIN "EventInstance" i ON i."id" = r."eventInstanceId"`;

/**
 * One page of the user's registrations in a section, ordered across one-off
 * events and series occurrences together (the event's dates win, as in
 * `normalise`): Upcoming soonest first, Past most recent first, then by id.
 * Keyed on `RSVP.userId` only, with a separate count for the page numbers.
 */
async function registrationSectionPage(userId: string, now: Date, section: "upcoming" | "past", requestedPage: number) {
  const at = sqlUtcTimestamp(now);
  const where =
    section === "upcoming"
      ? Prisma.sql`r."userId" = ${userId} AND COALESCE(e."endDateTime", i."endDateTime") >= ${at}`
      : Prisma.sql`r."userId" = ${userId} AND COALESCE(e."endDateTime", i."endDateTime") < ${at}`;
  const order =
    section === "upcoming"
      ? Prisma.sql`COALESCE(e."startDateTime", i."startDateTime") ASC, r."id" ASC`
      : Prisma.sql`COALESCE(e."startDateTime", i."startDateTime") DESC, r."id" ASC`;
  const counted = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS "count" FROM ${REGISTRATION_FROM} WHERE ${where}`;
  const pagination = accountSectionPagination(requestedPage, Number(counted[0]?.count ?? 0), ACCOUNT_REGISTRATIONS_LIMIT);
  if (pagination.total === 0) return { rows: [] as AccountRsvpRow[], pagination };
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT r."id" FROM ${REGISTRATION_FROM}
    WHERE ${where}
    ORDER BY ${order}
    LIMIT ${ACCOUNT_REGISTRATIONS_LIMIT} OFFSET ${(pagination.page - 1) * ACCOUNT_REGISTRATIONS_LIMIT}`;
  const found = ids.length
    ? await prisma.rSVP.findMany({ where: { id: { in: ids.map((row) => row.id) }, userId }, select: rsvpSelect })
    : [];
  const byId = new Map(found.map((rsvp) => [rsvp.id, rsvp]));
  return { rows: ids.flatMap((row) => byId.get(row.id) ?? []), pagination };
}

/** One page of the user's certificates, newest first (issued token on their own confirmed RSVP, as the certificate route checks). */
async function certificatePage(userId: string, requestedPage: number) {
  const where = { certificateToken: { not: null }, rsvp: { is: { userId, status: RsvpStatus.CONFIRMED } } } satisfies Prisma.EventFeedbackResponseWhereInput;
  const total = await prisma.eventFeedbackResponse.count({ where });
  const pagination = accountSectionPagination(requestedPage, total, ACCOUNT_CERTIFICATES_LIMIT);
  const rows = total
    ? await prisma.eventFeedbackResponse.findMany({
        where,
        orderBy: [{ submittedAt: "desc" }, { id: "asc" }],
        skip: (pagination.page - 1) * ACCOUNT_CERTIFICATES_LIMIT,
        take: ACCOUNT_CERTIFICATES_LIMIT,
        select: {
          id: true,
          certificateToken: true,
          submittedAt: true,
          form: { select: { event: { select: { title: true, timezone: true, organisation: { select: { name: true } } } } } },
        },
      })
    : [];
  return { rows, pagination };
}

/**
 * The records behind `loadAccountRegistrations`: ownership, ordering, page
 * size and page-reachability rules. Each section is paged on its own
 * (`pages`, default page 1).
 */
export async function loadAccountRegistrationRecords(userId: string, now: Date = new Date(), pages: Partial<AccountPages> = {}) {
  const [upcomingPage, pastPage, certificatesPage, user] = await Promise.all([
    registrationSectionPage(userId, now, "upcoming", pages.upcoming ?? 1),
    registrationSectionPage(userId, now, "past", pages.past ?? 1),
    certificatePage(userId, pages.certificates ?? 1),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, emailVerified: true } }),
  ]);
  const certificates = certificatesPage.rows;

  const rsvps = [...upcomingPage.rows, ...pastPage.rows];

  // Invite-only pages require an invitation for the user's verified email,
  // exactly as `resolvePublicEventAccess` does. Batched, bounded by the RSVP ids above.
  const email = user?.emailVerified ? user.email?.trim().toLowerCase() : null;
  const inviteOnlyEventIds = [...new Set(rsvps.flatMap((r) => (r.event?.privacyType === EventPrivacyType.INVITE_ONLY ? [r.event.id] : [])))];
  const inviteOnlySeriesIds = [...new Set(rsvps.flatMap((r) => (r.eventInstance?.series.privacyType === EventPrivacyType.INVITE_ONLY ? [r.eventInstance.series.id] : [])))];
  const [eventInvites, seriesInvites] = email
    ? await Promise.all([
        inviteOnlyEventIds.length
          ? prisma.eventInvite.findMany({ where: { email, eventId: { in: inviteOnlyEventIds } }, select: { eventId: true } })
          : Promise.resolve([]),
        inviteOnlySeriesIds.length
          ? prisma.seriesInvite.findMany({ where: { email, eventSeriesId: { in: inviteOnlySeriesIds } }, select: { eventSeriesId: true } })
          : Promise.resolve([]),
      ])
    : [[], []];
  const invitedEventIds = new Set(eventInvites.map((invite) => invite.eventId));
  const invitedSeriesIds = new Set(seriesInvites.map((invite) => invite.eventSeriesId));

  const normaliseAll = (rows: AccountRsvpRow[]) =>
    rows.flatMap((rsvp) => {
      const item = normalise(rsvp, invitedEventIds, invitedSeriesIds);
      return item ? [item] : [];
    });

  return {
    upcoming: normaliseAll(upcomingPage.rows),
    past: normaliseAll(pastPage.rows),
    pagination: { upcoming: upcomingPage.pagination, past: pastPage.pagination, certificates: certificatesPage.pagination },
    certificates: certificates.flatMap((response): AccountCertificateRecord[] =>
      response.certificateToken
        ? [{
            id: response.id,
            title: response.form.event.title,
            organisationName: response.form.event.organisation.name,
            issuedAt: response.submittedAt,
            timeZone: safeTimeZone(response.form.event.timezone),
            certificateHref: `/api/feedback/certificate/${response.certificateToken}`,
          }]
        : [],
    ),
  };
}
