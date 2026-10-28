import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadJudgeWorkspace } from "@/lib/views/components__event-dashboard__judging__JudgeWorkspace";
import { EmptyState } from "@/components/ui/display";
import { NoPermission } from "@/components/event-dashboard/panels/shared";
import { JudgeWorkspaceRounds } from "./JudgeWorkspaceRounds";

/**
 * The judge workspace (docs/HACKATHON.md): the submissions this person may
 * score, their own progress, and a scoring view per submission. Shown on its
 * own to a JUDGE-only collaborator, and as "Score submissions" inside the
 * Judging tab for organisation owners and admins.
 *
 * Access is re-resolved from the session user (resolveJudgeContext), and the
 * list comes from the judging core, which applies assignments, conflict of
 * interest, and status filters in the query. Only the first page (and totals)
 * load here; filters, search and "Load more" go through
 * `loadJudgeSubmissionsPage`. Only project content and this judge's own
 * progress reach the browser: never entrant emails, answers, or tickets.
 */
export async function JudgeWorkspace({ ctx }: { ctx: EventDashboardContext }) {
  const workspace = await loadJudgeWorkspace({ ctx });
  if (workspace.state === "denied") return <NoPermission>You do not have access to judging for this event.</NoPermission>;
  if (workspace.state === "off") {
    return (
      <EmptyState title="Project submissions are off">
        {workspace.canManage
          ? "Turn on project submissions in the judging settings to start collecting and scoring projects."
          : "The organisers have not turned on project submissions for this event yet."}
      </EmptyState>
    );
  }
  const { state: _state, organisationSlug, eventId, ...dto } = workspace;
  void _state;
  return <JudgeWorkspaceRounds organisationSlug={organisationSlug} eventId={eventId} audience={ctx.permissions.canManageJudging ? "organiser" : "judge"} workspace={dto} />;
}
