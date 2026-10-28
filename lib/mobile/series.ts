import "server-only";

import { EventPrivacyType, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { seatTakingWhere } from "@/lib/payments/holds";
import { currentMobileActor } from "@/lib/requestActor";
import { loadInstanceEventView } from "@/lib/views/app__orgSlug__i__instanceId__page";
import { seriesDateDtoSchema } from "@/lib/mobile/schemas";

/*
 * A recurring series date as its public page shows it (the same view reader,
 * so access, members-only tickets, passes and paid-sales rules match), plus
 * the series' next dates for a date picker.
 */

const UPCOMING_DATES = 30;

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest: unknown; }).digest).startsWith("NEXT_HTTP_ERROR_FALLBACK;404");
}

export async function loadSeriesDate(orgSlug: string, instanceId: string) {
  if (!instanceId || instanceId.length > 128) return null;
  const view = await loadInstanceEventView({ params: Promise.resolve({ orgSlug, instanceId }) }).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw error;
  });
  if (!view) return null;
  const now = new Date();
  const upcoming = await prisma.eventInstance.findMany({
    where: { eventSeriesId: view.series.id, startDateTime: { gte: now }, cancelledAt: null },
    orderBy: { startDateTime: "asc" },
    take: UPCOMING_DATES,
    select: { id: true, startDateTime: true, endDateTime: true, capacity: true, cancelledAt: true, _count: { select: { rsvps: { where: seatTakingWhere(now) } } } },
  });
  const viewerId = currentMobileActor()?.userId;
  const mine = viewerId ? await prisma.rSVP.findFirst({ where: { eventInstanceId: view.instance.id, userId: viewerId }, select: { id: true, status: true, checkInToken: true } }) : null;
  const capacityOf = (capacity: number | null) => capacity ?? view.series.capacity;
  const ticketing = view.ticketing ? {
    currency: view.series.currency ?? view.tickets[0]?.currency ?? "INR",
    tickets: view.tickets,
    addOns: view.ticketing.addOns,
    promoCodes: view.ticketing.promoCodes,
    accessCodes: view.ticketing.accessCodes,
    sellsPaid: view.ticketing.sellsPaid,
    paidSalesOpen: view.paidSalesOpen,
    refundPolicy: view.ticketing.refundPolicy ? `${view.ticketing.refundPolicy}${view.ticketing.refundPolicyText ? ` ${view.ticketing.refundPolicyText}` : ""}` : null,
  } : null;
  return seriesDateDtoSchema.parse({
    series: {
      slug: view.series.slug,
      title: view.series.title,
      description: view.series.description,
      timezone: view.timeZone,
      requiresApproval: view.series.privacyType === EventPrivacyType.APPROVAL_REQUIRED,
    },
    date: {
      instanceId: view.instance.id,
      startDateTime: view.instance.startDateTime.toISOString(),
      endDateTime: view.instance.endDateTime.toISOString(),
      capacity: view.capacity,
      spotsLeft: view.spotsLeft,
      cancelled: view.cancelled,
    },
    registrationOpen: view.showRsvp,
    paidRequest: view.paidRequest,
    myRsvp: mine ? { rsvpId: mine.id, status: mine.status, ticketToken: mine.status === RsvpStatus.CONFIRMED ? mine.checkInToken : null } : null,
    ticketing,
    upcomingDates: upcoming.map((date) => {
      const capacity = capacityOf(date.capacity);
      return {
        instanceId: date.id,
        startDateTime: date.startDateTime.toISOString(),
        endDateTime: date.endDateTime.toISOString(),
        capacity,
        spotsLeft: capacity != null ? Math.max(0, capacity - date._count.rsvps) : null,
        cancelled: date.cancelledAt != null,
      };
    }),
  });
}
