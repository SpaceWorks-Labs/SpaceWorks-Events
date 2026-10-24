import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { resolveJudgeContext } from "@/lib/judgingAccess";
import { listSubmissionsForJudge } from "@/lib/core/judging";

/** The judge workspace (docs/HACKATHON.md): owners, admins and JUDGE collaborators only. */
export async function loadJudgeWorkspace({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.canJudge) return { state: "denied" as const };
  const judge = await resolveJudgeContext(ctx.userId, ctx.organisation.slug, ctx.event.id);
  if (!judge) return { state: "denied" as const };
  const workspace = await listSubmissionsForJudge(judge);
  if (!workspace) return { state: "off" as const, canManage: ctx.permissions.canManageJudging };
  return { state: "ready" as const, organisationSlug: ctx.organisation.slug, eventId: ctx.event.id, ...workspace };
}
