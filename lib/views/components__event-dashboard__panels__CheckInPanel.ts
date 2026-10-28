import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadCheckInDesk } from "@/lib/eventDashboard/checkIn";
import { loadCheckInLists, loadListAddOns } from "@/lib/eventDashboard/checkInLists";
import { doorsStatus, seatDots } from "@/components/event-dashboard/check-in/doors";



export async function loadCheckInPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, organisation, now } = ctx;
  if (!permissions.canCheckIn) notFound();

  const [desk, lists, addOns] = await Promise.all([loadCheckInDesk(ctx), loadCheckInLists(event.id), loadListAddOns(event.id)]);
  const checkInHref = `/dashboard/${organisation.slug}/event/${event.id}/check-in`;
  const doors = doorsStatus({ start: event.startDateTime, end: event.endDateTime, timezone: event.timezone, now, cancelled: event.status === "CANCELLED" });
  const { seats, lit } = seatDots(desk.checkedIn, desk.confirmed);


  return { event, permissions, organisation, now, desk, lists, addOns, checkInHref, doors, seats, lit };
}

import { notFound } from "next/navigation";
import { loadEventDashboard } from "@/lib/eventDashboard/context";

/** EDIT_DETAILS co-organisers set up the lists without the check-in permission; scanning stays with CHECK_IN. */
export async function loadCheckInListsSetup({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canManageCheckInLists) notFound();
  const [lists, addOns] = await Promise.all([loadCheckInLists(ctx.event.id), loadListAddOns(ctx.event.id)]);
  return { lists, addOns };
}
