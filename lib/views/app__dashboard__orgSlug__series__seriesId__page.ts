import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { EventPermission } from "@prisma/client";
import { getRequestOrigin } from "@/lib/publicUrl";
import { isOrgAdmin, requireOrgDashboardAccess } from "@/lib/permissions";
import { canViewEventDashboard } from "@/lib/eventAccess";
import { percentOf } from "@/components/event-dashboard/analytics/metrics";
import { seatTakingWhere } from "@/lib/payments/holds";
import { loadTicketSettings } from "@/lib/payments/ticketSettings";
import { loadRevenue } from "@/lib/payments/revenue";
import { listFailedRefunds } from "@/lib/payments/operations/retryRefund";
import { listRefundableOrders } from "@/lib/payments/operations/cancelledRefund";
import { listAttendeesPage } from "@/lib/eventDashboard/attendees";
type Props = { params: Promise<{ orgSlug: string; seriesId: string; }>; };
export async function loadSeriesManageView({ params }: Props) {
  const { orgSlug, seriesId } = await params;
  const access = await requireOrgDashboardAccess(orgSlug);
  const { organisation } = access;
  const series = await prisma.eventSeries.findFirst({
    where: { id: seriesId, organisationId: organisation.id },
    include: {
      instances: {
        orderBy: { startDateTime: "asc" },
        take: 20,
      },
      scheduleItems: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!series) notFound();
  if (!access.membership && !(await canViewEventDashboard({ userId: access.userId, organisationId: organisation.id, eventSeriesId: series.id }))) notFound();
  const isAdmin = Boolean(access.membership && isOrgAdmin(access.membership.role));
  const currentGrant = isAdmin ? null : await prisma.eventCollaborator.findFirst({
    where: { eventSeriesId: series.id, userId: access.userId },
    select: { permissions: true },
  });
  const granted = (permission: EventPermission) => isAdmin || Boolean(currentGrant?.permissions.includes(permission));
  // Guest list and registration numbers: admins, or the MANAGE_REGISTRATIONS grant on this series.
  const canManageRegistrations = granted(EventPermission.MANAGE_REGISTRATIONS);
  const canManageInvites = granted(EventPermission.MANAGE_INVITATIONS);
  const canManageSchedule = granted(EventPermission.PUBLISH_AND_SCHEDULE);
  // Ticket types, passes, promo codes and the refund policy: as on an event.
  const canEditTickets = granted(EventPermission.EDIT_DETAILS);
  const invites = canManageInvites
    ? await prisma.seriesInvite.findMany({
      where: { eventSeriesId: series.id },
      orderBy: { createdAt: "desc" },
    })
    : [];
  const now = new Date();
  const upcoming = await prisma.eventInstance.findMany({
    where: { eventSeriesId: series.id, endDateTime: { gt: now } },
    orderBy: { startDateTime: "asc" },
    select: { id: true, startDateTime: true, capacity: true, cancelledAt: true },
  });
  // Keep every cancelled past date reachable even after it leaves Upcoming dates.
  const pastCancelled = isAdmin ? await prisma.eventInstance.findMany({
    where: { eventSeriesId: series.id, endDateTime: { lte: now }, cancelledAt: { not: null } },
    orderBy: { startDateTime: "desc" },
    select: { id: true, startDateTime: true, capacity: true },
  }) : [];
  const managedIds = [...upcoming, ...pastCancelled].map((date) => date.id);
  const takenRows = managedIds.length
    ? await prisma.rSVP.groupBy({ by: ["eventInstanceId"], where: { eventInstanceId: { in: managedIds }, ...seatTakingWhere(now) }, _count: { _all: true } })
    : [];
  const takenBy = new Map(takenRows.map((row) => [row.eventInstanceId as string, row._count._all]));
  const dates = upcoming.map((date) => ({ id: date.id, start: date.startDateTime.toISOString(), capacity: date.capacity, taken: takenBy.get(date.id) ?? 0, cancelled: date.cancelledAt != null }));
  const pastCancelledDates = pastCancelled.map((date) => ({ id: date.id, start: date.startDateTime.toISOString(), capacity: date.capacity, taken: takenBy.get(date.id) ?? 0, cancelled: true }));
  const tickets = canEditTickets
    ? await loadTicketSettings({ owner: { eventSeriesId: series.id }, organisation, currency: series.currency, refundPolicy: series, transfers: series, now })
    : null;
  // The guest list shows the next date that is still on.
  const firstInstanceId = upcoming.find((date) => !date.cancelledAt)?.id;
  const origin = await getRequestOrigin();
  // The first page of the date's guests; further pages, filters and search
  // go through `loadAttendeesPage` with the same series grant check.
  const attendeesPage = firstInstanceId && canManageRegistrations
    ? await listAttendeesPage({ kind: "instance", eventInstanceId: firstInstanceId, organisationId: organisation.id }, {}, { origin, teamMode: false })
    : null;
  const canDownloadReports = Boolean(access.membership && isOrgAdmin(access.membership.role));
  const finishedInstances = series.instances.filter((instance) => instance.endDateTime < now);
  // Attendance across finished occurrences (organisers only): counts, never people.
  let rollup: { rows: Array<{ id: string; start: Date; going: number; came: number; turnout: number | null }>; averageTurnout: number | null; totalCame: number } | null = null;
  if (canDownloadReports && finishedInstances.length) {
    const ids = finishedInstances.map((instance) => instance.id);
    const [going, came] = await Promise.all([
      prisma.rSVP.groupBy({ by: ["eventInstanceId"], where: { eventInstanceId: { in: ids }, status: "CONFIRMED" }, _count: { _all: true } }),
      prisma.rSVP.groupBy({ by: ["eventInstanceId"], where: { eventInstanceId: { in: ids }, status: "CONFIRMED", checkedInAt: { not: null } }, _count: { _all: true } }),
    ]);
    const goingBy = new Map(going.map((row) => [row.eventInstanceId as string, row._count._all]));
    const cameBy = new Map(came.map((row) => [row.eventInstanceId as string, row._count._all]));
    const rows = finishedInstances.map((instance) => {
      const g = goingBy.get(instance.id) ?? 0;
      const c = cameBy.get(instance.id) ?? 0;
      return { id: instance.id, start: instance.startDateTime, going: g, came: c, turnout: percentOf(c, g) };
    });
    const totalGoing = rows.reduce((sum, row) => sum + row.going, 0);
    const totalCame = rows.reduce((sum, row) => sum + row.came, 0);
    rollup = { rows, averageTurnout: percentOf(totalCame, totalGoing), totalCame };
  }
  // Takings across every date and pass, for those who manage registrations.
  const revenue = canManageRegistrations ? await loadRevenue({ eventSeriesId: series.id }, series.timezone, now) : null;
  // Refunds the provider refused, for owners and admins to retry (docs/PAYMENTS.md).
  const failedRefunds = isAdmin ? await listFailedRefunds({ eventSeriesId: series.id }, organisation.id) : [];
  // Money left on cancelled or expired orders, refunded by order.
  const refundableOrders = isAdmin ? await listRefundableOrders({ eventSeriesId: series.id }, organisation.id) : [];
  return { series, isAdmin, organisation, canManageInvites, invites, canManageSchedule, canDownloadReports, finishedInstances, firstInstanceId, canManageRegistrations, now, attendeesPage, rollup, dates, pastCancelledDates, tickets, revenue, failedRefunds, refundableOrders };
}
