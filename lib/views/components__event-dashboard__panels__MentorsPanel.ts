import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { resolveDeskOrganiser } from "@/lib/core/mentorDesk/access";
import { loadDeskOrganiserView } from "@/lib/core/mentorDesk/readsOrganiser";

/** The Mentors tab for organisation owners and admins (docs/MENTOR_DESK.md). */
export async function loadMentorsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canManageMentorDesk) return null;
  const organiser = await resolveDeskOrganiser(ctx.userId, ctx.organisation.slug, ctx.event.id);
  if (!organiser) return null;
  const view = await loadDeskOrganiserView(organiser, ctx.now);
  return view ? { view, scope: { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id } } : null;
}
