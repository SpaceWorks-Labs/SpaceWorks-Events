import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { listMyReviews } from "@/lib/admission/reviews";

/** The signed-in reviewer's own assignments on this event (docs/ADMISSION.md "Reviewing"). */
export async function loadReviewWorkspace({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canReviewApplications) return null;
  return listMyReviews({ userId: ctx.userId, organisationId: ctx.organisation.id, orgSlug: ctx.organisation.slug, eventId: ctx.event.id, eventSlug: ctx.event.slug, isAdmin: ctx.permissions.isAdmin });
}
