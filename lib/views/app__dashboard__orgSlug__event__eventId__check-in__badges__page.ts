import { eventForView } from "@/lib/frontend/eventView";
import { notFound } from "next/navigation";
import { RsvpStatus } from "@prisma/client";
import { canUseBadges } from "@/lib/badge/access";
import { loadBadgeEvent } from "@/lib/badge/data";
import { BULK_BADGE_LIMIT } from "@/lib/badge/sheet";
import { prisma } from "@/lib/db";
import { requireOrgDashboardAccess } from "@/lib/permissions";
type Props = { params: Promise<{ orgSlug: string; eventId: string; }>; };
const LISTED_STATUSES = [RsvpStatus.CONFIRMED, RsvpStatus.WAITLISTED, RsvpStatus.PENDING_APPROVAL];

export async function loadEventBadgesView({ params }: Props) {
  const { orgSlug, eventId } = await params;
  const access = await requireOrgDashboardAccess(orgSlug);
  const event = await loadBadgeEvent(eventId);
  if (!event || event.organisationId !== access.organisation.id || !(await canUseBadges(access.userId, event))) notFound();
  const [details, rsvps, total, form] = await Promise.all([
    prisma.event.findUniqueOrThrow({
      where: { id: event.id },
      select: { status: true, privacyType: true, startDateTime: true, timezone: true, page: { select: { accentColor: true } } },
    }),
    // Names and statuses only: ticket tokens are fetched per badge when printing.
    prisma.rSVP.findMany({
      where: { eventId: event.id, status: { in: LISTED_STATUSES } },
      orderBy: { createdAt: "asc" },
      take: BULK_BADGE_LIMIT,
      select: { id: true, status: true, isCrew: true, checkedInAt: true, guestName: true, guestEmail: true, user: { select: { name: true, email: true } } },
    }),
    prisma.rSVP.count({ where: { eventId: event.id, status: { in: LISTED_STATUSES } } }),
    prisma.eventRegistrationForm.findUnique({
      where: { eventId: event.id },
      select: { fields: { select: { key: true, label: true }, orderBy: { sortOrder: "asc" } } },
    }),
  ]);
  const attendees = rsvps.map((rsvp) => ({
    rsvpId: rsvp.id,
    displayName: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || rsvp.user?.email || rsvp.guestEmail || "Guest",
    email: rsvp.user?.email ?? rsvp.guestEmail,
    status: rsvp.status,
    checkedIn: Boolean(rsvp.checkedInAt),
    isCrew: rsvp.isCrew,
  }));
  return { access, event: eventForView(event), details, form, attendees, total };
}
