import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { loadJudgingDashboard } from "@/lib/eventDashboard/judging";

/** Judging settings, rubric, submissions, awards and results: owners and admins only. */
export async function loadJudgingPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canManageJudging) return null;
  return loadJudgingDashboard(ctx);
}
