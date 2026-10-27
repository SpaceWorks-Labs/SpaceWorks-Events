import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { resolveMentorContext } from "@/lib/core/mentorDesk/access";
import { loadMentorConsole } from "@/lib/core/mentorDesk/readsMentor";

/** The mentor console: a MENTOR grant holder's own queue, teams, slots and visits (docs/MENTOR_DESK.md). */
export async function loadMentorConsoleView({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canMentor) return null;
  const mentor = await resolveMentorContext(ctx.userId, ctx.organisation.slug, ctx.event.id);
  if (!mentor) return null;
  const view = await loadMentorConsole(mentor, ctx.now);
  return view ? { view, scope: { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id } } : null;
}
