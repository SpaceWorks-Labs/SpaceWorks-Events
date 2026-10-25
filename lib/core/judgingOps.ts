import "server-only";

/*
 * Judging operations for organisers (docs/HACKATHON.md): automatic judge
 * assignment, the per-project review target, and the Progress dashboard.
 * Organisation OWNER/ADMIN only: callers resolve `JudgingOrganiserContext`
 * (`resolveJudgingOrganiser`, the same check as every other judging
 * management surface), and every read here is re-scoped by event and
 * organisation. The assignment rules are pure functions in
 * lib/judgingAssignment.ts; the progress rules in lib/judgingProgress.ts.
 *
 * The parts live in lib/core/judgingOps/; this file is their public entry.
 */

export { setReviewsPerProject } from "./judgingOps/reviewTarget";
export {
  type AutoAssignJudgeRow,
  type AutoAssignShortfallRow,
  type AutoAssignPreviewDto,
  type AutoAssignAppliedDto,
  previewAutoAssignment,
  applyAutoAssignment,
} from "./judgingOps/autoAssign";
export {
  type ProgressBelowTargetRow,
  type ProgressJudgeRow,
  type ProgressOutlierRow,
  type ProgressStaleRow,
  type JudgingProgressSummary,
  type ProgressSectionPage,
  type JudgingProgressDto,
  type JudgingProgressSectionDto,
} from "./judgingOps/progressTypes";
export { loadJudgingProgress, loadJudgingProgressPage } from "./judgingOps/progress";
