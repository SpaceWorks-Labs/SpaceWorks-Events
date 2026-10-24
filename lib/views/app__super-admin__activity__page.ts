import { requireSuperAdminMfa } from "@/lib/permissions";
import { EventStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ACTIVITY_SERIES, loadDailyActivity, loadTopOrganisationsByRsvps } from "@/lib/superAdminData";
import { countConfirmedForEvent } from "@/lib/rsvpCapacity";
import { fillDailySeries, windowStart, DAY_MS } from "@/lib/superAdminInsights";
const WINDOW_DAYS = 30;



export async function loadSuperAdminActivityView() {
  await requireSuperAdminMfa();
  const now = new Date();
  const since = windowStart(WINDOW_DAYS * 2, now);
  const currentSince = windowStart(WINDOW_DAYS, now);
  const nextWeek = new Date(now.getTime() + 7 * DAY_MS);
  const [dailyRows, rsvpStatuses, topOrgs, upcoming, emptyOrgCount, emptyOrgs] = await Promise.all([
    loadDailyActivity(since),
    prisma.rSVP.groupBy({ by: ["status"], _count: { _all: true } }),
    loadTopOrganisationsByRsvps(currentSince).catch(() => []),
    prisma.event.findMany({
      where: { status: EventStatus.PUBLISHED, startDateTime: { gte: now, lt: nextWeek } },
      orderBy: { startDateTime: "asc" },
      take: 15,
      select: { id: true, title: true, startDateTime: true, capacity: true, registrationMode: true, soloPolicy: true, organisation: { select: { id: true, name: true } }, _count: { select: { rsvps: { where: { status: RsvpStatus.CONFIRMED } } } } },
    }),
    prisma.organisation.count({ where: { events: { none: {} }, eventSeries: { none: {} } } }),
    prisma.organisation.findMany({
      where: { events: { none: {} }, eventSeries: { none: {} } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, name: true, slug: true, createdAt: true, _count: { select: { memberships: true } } },
    }),
  ]);
  const series = fillDailySeries(dailyRows, ACTIVITY_SERIES, WINDOW_DAYS * 2, now);
  const rsvpTotal = rsvpStatuses.reduce((total, row) => total + row._count._all, 0);
  // TEAM events fill capacity in units (teams plus solo registrants), not people.
  const unitsByEvent: Record<string, number> = Object.fromEntries(
    await Promise.all(upcoming.filter((event) => event.registrationMode === "TEAM").map(async (event) => [event.id, await countConfirmedForEvent(event.id, event.registrationMode)] as const)),
  );
  return { series, rsvpStatuses, rsvpTotal, topOrgs, upcoming, emptyOrgCount, emptyOrgs, unitsByEvent };
}
