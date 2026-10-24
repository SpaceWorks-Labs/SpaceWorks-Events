import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { judgingOrganiserContext, loadJudgingDashboard } from "@/lib/eventDashboard/judging";
import { listEligibleJudges } from "@/lib/core/judging";
import { loadJudgingProgress } from "@/lib/core/judgingOps";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";

/** Judging → Progress: the summary and first pages, plus who can be picked for automatic assignment. */
async function loadProgressTab(organiser: JudgingOrganiserContext, now: Date) {
  const [data, judges] = await Promise.all([loadJudgingProgress(organiser, now), listEligibleJudges(organiser)]);
  return data ? { data, judges } : null;
}

/** Judging settings, rubric, submissions, progress, awards and results: owners and admins only. */
export async function loadJudgingPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canManageJudging) return null;
  const organiser = judgingOrganiserContext(ctx);
  const [data, progress] = await Promise.all([loadJudgingDashboard(ctx), organiser ? loadProgressTab(organiser, ctx.now) : null]);
  return data ? { ...data, progress } : null;
}
