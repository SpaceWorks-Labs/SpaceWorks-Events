import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadJudgingPanel } from "@/lib/views/components__event-dashboard__panels__JudgingPanel";
import {
  DISQUALIFY_REASON_MAX_LENGTH,
  EVENT_AWARD_NAME_MAX_LENGTH,
  EVENT_AWARD_PLACE_MAX,
  EVENT_AWARDS_LIMIT,
  JUDGING_CRITERIA_LIMIT,
  JUDGING_CRITERION_NAME_MAX_LENGTH,
  JUDGING_MAX_SCORE_LIMIT,
  JUDGING_TEXT_DESCRIPTION_MAX_LENGTH,
  JUDGING_WEIGHT_MAX,
} from "@/lib/validators";
import { FINALIZE_REASON_MAX_LENGTH, JUDGING_ROUND_NAME_MAX_LENGTH, JUDGING_ROUNDS_LIMIT } from "@/lib/validators/judgingRounds";
import { JudgeWorkspace } from "@/components/event-dashboard/judging/JudgeWorkspace";
import { SubTabs, type SubTab } from "../SubTabs";
import { JudgingPanelAwards } from "./JudgingPanelAwards";
import { PrizePayoutsPanel } from "./PrizePayoutsPanel";
import { JudgingPanelJudges } from "./JudgingPanelResults";
import { JudgingProgressByRound, JudgingResultsByRound } from "./JudgingRoundViews";
import { JudgingPanelRounds } from "./JudgingPanelRounds";
import { roundOptions } from "./judgingRoundsCopy";
import { JudgingPanelRubric } from "./JudgingPanelRubric";
import { JudgingPanelSetup } from "./JudgingPanelSetup";
import type { JudgingLimits } from "./JudgingPanelShared";
import { JudgingPanelSubmissions } from "./JudgingPanelSubmissions";
import { NoPermission } from "./shared";

const LIMITS: JudgingLimits = {
  criteria: JUDGING_CRITERIA_LIMIT,
  criterionName: JUDGING_CRITERION_NAME_MAX_LENGTH,
  description: JUDGING_TEXT_DESCRIPTION_MAX_LENGTH,
  weight: JUDGING_WEIGHT_MAX,
  maxScore: JUDGING_MAX_SCORE_LIMIT,
  awards: EVENT_AWARDS_LIMIT,
  awardName: EVENT_AWARD_NAME_MAX_LENGTH,
  awardPlace: EVENT_AWARD_PLACE_MAX,
  disqualifyReason: DISQUALIFY_REASON_MAX_LENGTH,
};
const ROUND_LIMITS = { ...LIMITS, roundName: JUDGING_ROUND_NAME_MAX_LENGTH, finalizeReason: FINALIZE_REASON_MAX_LENGTH, rounds: JUDGING_ROUNDS_LIMIT };

/**
 * The event dashboard's Judging tab (docs/HACKATHON.md). Organisation owners
 * and admins (`canManageJudging`, the same check as the organiser RSVP
 * actions) get setup, rubric, submissions, judges, progress, results, and awards. Anyone
 * who can judge also gets the judge workspace. A JUDGE-only collaborator never
 * reaches this panel: the page shows them the workspace on its own.
 */
export async function JudgingPanel({ ctx }: { ctx: EventDashboardContext }) {
  const { permissions } = ctx;
  if (!permissions.canManageJudging) {
    return permissions.canJudge ? <JudgeWorkspace ctx={ctx} /> : <NoPermission>You do not have permission to manage judging for this event.</NoPermission>;
  }

  const data = await loadJudgingPanel({ ctx });
  if (!data) return <NoPermission>You do not have permission to manage judging for this event.</NoPermission>;
  const { scope, settings, progress, savedViews, rounds } = data;
  const frozen = settings.judgingStatus !== "NOT_STARTED";
  // Rounds (docs/HACKATHON.md "Rounds"): the switchers, and the automatic-assignment pool narrowed to the current round's panel.
  const switcher = roundOptions(rounds);
  const currentPanel = rounds.find((round) => round.isCurrent)?.panelUserIds ?? [];
  const eventJudges = progress?.judges ?? [];
  const poolJudges = currentPanel.length ? eventJudges.filter((judge) => currentPanel.includes(judge.userId)) : eventJudges;

  const setup: SubTab = {
    value: "judging-setup",
    label: "Setup",
    content: (
      <div className="flex flex-col gap-5">
        <JudgingPanelSetup scope={scope} settings={settings} criteriaCount={data.criteria.length} submittedCount={data.counts.SUBMITTED} now={ctx.now.toISOString()} />
        <JudgingPanelRubric scope={scope} criteria={data.criteria} frozen={frozen} limits={LIMITS} />
      </div>
    ),
  };
  if (!settings.submissionsEnabled && data.submissionsTotal === 0 && settings.judgingStatus === "NOT_STARTED" && !settings.resultsPublishedAt) {
    // Nothing to judge yet: only the settings needed to turn submissions on.
    return <SubTabs label="Judging sections" items={[setup]} />;
  }

  return (
    <SubTabs
      label="Judging sections"
      items={[
        setup,
        {
          value: "judging-rounds",
          label: "Rounds",
          count: rounds.length > 1 ? rounds.length : undefined,
          content: <JudgingPanelRounds scope={scope} rounds={rounds} judges={eventJudges} timezone={settings.timezone} limits={ROUND_LIMITS} />,
        },
        {
          value: "judging-submissions",
          label: "Submissions",
          count: data.submissionsTotal,
          content: (
            <JudgingPanelSubmissions
              scope={scope}
              initialPage={data.submissions}
              counts={data.counts}
              total={data.submissionsTotal}
              judges={data.judges}
              criteria={data.criteria}
              judgesSeeAll={settings.judgesSeeAll}
              timezone={settings.timezone}
              awards={data.awards}
              resultsPublished={Boolean(settings.resultsPublishedAt)}
              limits={LIMITS}
              unsubmittedCount={data.unsubmittedCount}
              savedViews={savedViews.JUDGING_SUBMISSIONS ?? []}
            />
          ),
        },
        {
          value: "judging-judges",
          label: "Judges",
          // Invited judges only: organisers can always judge, so counting them would never show 0.
          count: data.judges.filter((judge) => judge.kind === "judge").length,
          content: <JudgingPanelJudges judges={data.judges} judgesSeeAll={settings.judgesSeeAll} />,
        },
        {
          value: "judging-progress",
          label: "Progress",
          content: progress ? (
            <JudgingProgressByRound
              rounds={switcher}
              scope={scope}
              initial={progress.data}
              judges={poolJudges}
              timezone={settings.timezone}
              now={ctx.now.toISOString()}
              savedViews={savedViews.JUDGING_PROGRESS ?? []}
            />
          ) : (
            <NoPermission>You do not have permission to manage judging for this event.</NoPermission>
          ),
        },
        {
          value: "judging-score",
          label: "Score",
          content: <JudgeWorkspace ctx={ctx} />,
        },
        {
          value: "judging-results",
          label: "Results",
          content: (
            <JudgingResultsByRound
              rounds={switcher}
              scope={scope}
              initialPage={data.results}
              criteria={data.criteria}
              judgingStatus={settings.judgingStatus}
              resultsPublishedAt={settings.resultsPublishedAt}
              resultsAnnouncedAt={settings.resultsAnnouncedAt}
              emailEntrantsOnResults={settings.emailEntrantsOnResults}
              announcementRecipients={data.announcementRecipients}
              resultsUrl={data.resultsUrl}
              exportHref={data.exportHref}
              timezone={settings.timezone}
              savedViews={savedViews.JUDGING_RESULTS ?? []}
            />
          ),
        },
        {
          value: "judging-awards",
          label: "Awards",
          count: data.awards.length,
          content: <JudgingPanelAwards scope={scope} awards={data.awards} submittedCount={data.counts.SUBMITTED} resultsPublished={Boolean(settings.resultsPublishedAt)} limits={LIMITS} />,
        },
        // Prize money is for owners and admins only (docs/HACKATHON.md).
        ...(permissions.isAdmin ? [{ value: "judging-prizes", label: "Prizes", content: <PrizePayoutsPanel ctx={ctx} /> }] : []),
      ]}
    />
  );
}
