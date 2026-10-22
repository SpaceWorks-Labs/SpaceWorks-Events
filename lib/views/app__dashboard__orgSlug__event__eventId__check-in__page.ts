import { eventForView } from "@/lib/frontend/eventView";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { EventPermission } from "@prisma/client";
import { isOrgAdmin, requireOrgDashboardAccess } from "@/lib/permissions";
import { canAccessEvent } from "@/lib/eventAccess";
import { getRequestOrigin } from "@/lib/publicUrl";
import { loadBadgeEvent } from "@/lib/badge/data";
import { eventCapabilities } from "@/lib/eventDashboard/capabilities";
import { loadCheckInListRoster, loadCheckInLists } from "@/lib/eventDashboard/checkInLists";
type Props = {
  params: Promise<{ orgSlug: string; eventId: string; }>;
  searchParams: Promise<{ list?: string | string[]; }>;
};
function labelAttendee(r: {
  user: { name: string | null; email: string | null; } | null;
  guestName: string | null;
  guestEmail: string | null;
}) {
  const name = r.user?.name?.trim() || r.guestName?.trim();
  if (name) return name;
  const email = r.user?.email ?? r.guestEmail;
  return email ?? "Guest";
}
export async function loadEventCheckInView({ params, searchParams }: Props) {
  const { orgSlug, eventId } = await params;
  const { list: listParam } = await searchParams;
  const access = await requireOrgDashboardAccess(orgSlug);
  const { organisation } = access;
  const event = await prisma.event.findFirst({
    where: { id: eventId, organisationId: organisation.id },
    include: { page: { select: { accentColor: true } } },
  });
  if (!event) notFound();
  const isAdmin = Boolean(access.membership && isOrgAdmin(access.membership.role));
  if (!isAdmin && !(await canAccessEvent({ userId: access.userId, organisationId: organisation.id, eventId: event.id, permission: EventPermission.CHECK_IN }))) notFound();
  const grant = isAdmin
    ? null
    : await prisma.eventCollaborator.findFirst({ where: { eventId: event.id, userId: access.userId }, select: { permissions: true } });
  const capabilities = eventCapabilities(access.membership?.role ?? null, grant?.permissions ?? []);
  // Custom check-in lists: "Entry" is the unchanged desk; a selected open list
  // swaps in its own desk. Archived lists are hidden from the desk.
  const lists = await loadCheckInLists(event.id);
  const openLists = lists.filter((list) => !list.archived);
  const selectedId = typeof listParam === "string" ? listParam : null;
  const selectedList = selectedId ? openLists.find((list) => list.id === selectedId) ?? null : null;
  const listDesk = { lists, openLists, selectedList, canManage: capabilities.canManageCheckInLists, deskPath: `/dashboard/${organisation.slug}/event/${event.id}/check-in` };
  if (selectedList) {
    const roster = await loadCheckInListRoster(event.id, selectedList);
    return { mode: "list" as const, organisation, event: eventForView(event), listDesk, selectedList, roster };
  }
  const [confirmed, checkedInCount, recentRsvps, registrationForm, badgeEvent] = await Promise.all([
    prisma.rSVP.count({
      where: { eventId: event.id, status: "CONFIRMED" },
    }),
    prisma.rSVP.count({
      where: { eventId: event.id, checkedInAt: { not: null } },
    }),
    prisma.rSVP.findMany({
      where: { eventId: event.id, checkedInAt: { not: null } },
      orderBy: { checkedInAt: "desc" },
      take: 200,
      include: { user: { select: { name: true, email: true } } },
    }),
    prisma.eventRegistrationForm.findUnique({
      where: { eventId: event.id },
      select: {
        fields: {
          select: { key: true, label: true },
          orderBy: { sortOrder: "asc" },
        },
      },
    }),
    loadBadgeEvent(event.id),
  ]);
  if (!badgeEvent) notFound();
  const recent = recentRsvps.map((r) => ({
    rsvpId: r.id,
    displayName: labelAttendee(r),
    email: r.user?.email ?? r.guestEmail,
    checkedInAt: r.checkedInAt!.toISOString(),
  }));
  const origin = await getRequestOrigin();
  const stationUrl = `${origin}/${organisation.slug}/${event.slug}/check-in`;
  const badgesHref = `/dashboard/${organisation.slug}/event/${event.id}/check-in/badges`;
  return { mode: "entry" as const, listDesk, canManageStation: capabilities.canManageCheckInStation, confirmed, organisation, stationEnabled: Boolean(event.checkInStationPinHash), event: eventForView(event), badgesHref, registrationForm, checkedInCount, recent, badgeEvent, isAdmin, stationUrl };
}
