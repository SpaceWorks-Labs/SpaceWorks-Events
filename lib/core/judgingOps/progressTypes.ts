import "server-only";

/** DTOs of the judging Progress dashboard. */

import { JudgingStatus } from "@prisma/client";
import type { NumberedPage } from "@/lib/judgingOrganiserPaging";

export type ProgressBelowTargetRow = {
  submissionId: string;
  title: string;
  entrantName: string;
  /** Counted (submitted) reviews. */
  reviews: number;
  /** Judges with saved scores but no submitted review. */
  inProgress: number;
  /** Assignments to judges who may judge it. */
  assigned: number;
  missing: number;
};

export type ProgressJudgeRow = {
  userId: string;
  name: string;
  email: string | null;
  kind: "admin" | "judge";
  /** Projects this judge is expected to review: their assignments, or every project they may see when judges see all. */
  assigned: number;
  /** Started (scores saved) but not submitted. */
  started: number;
  /** Counted reviews. */
  submitted: number;
  /** Assigned projects the judge recused themselves from (left out of `assigned`, like a missing review). */
  recused: number;
  /** Submitted reviews of expected projects over expected projects, 0..100. */
  completion: number;
};

export type ProgressOutlierRow = {
  submissionId: string;
  title: string;
  judgeUserId: string;
  judgeName: string;
  score: number;
  othersMean: number;
  difference: number;
  judges: number;
  rule: "sd" | "fallback";
};

export type ProgressStaleRow = {
  submissionId: string;
  title: string;
  judgeUserId: string;
  judgeName: string;
  scored: number;
  criteria: number;
  /** ISO time of the last saved score. */
  lastSavedAt: string;
};

export type JudgingProgressSummary = {
  target: number;
  /** True when the organiser hasn't set a target and the default applies. */
  targetIsDefault: boolean;
  reviewsPerProject: number | null;
  judgingStatus: JudgingStatus;
  judgesSeeAll: boolean;
  projects: number;
  projectsAtTarget: number;
  reviewsCounted: number;
  /** Reviews towards the target (each project capped at the target) over projects × target, 0..100. */
  coverage: number;
};

export type ProgressSectionPage<T> = NumberedPage<T>;

export type JudgingProgressDto = {
  summary: JudgingProgressSummary;
  belowTarget: ProgressSectionPage<ProgressBelowTargetRow>;
  judges: ProgressSectionPage<ProgressJudgeRow>;
  outliers: ProgressSectionPage<ProgressOutlierRow>;
  stale: ProgressSectionPage<ProgressStaleRow>;
};

export type JudgingProgressSectionDto =
  | { section: "below-target"; page: ProgressSectionPage<ProgressBelowTargetRow> }
  | { section: "judges"; page: ProgressSectionPage<ProgressJudgeRow> }
  | { section: "outliers"; page: ProgressSectionPage<ProgressOutlierRow> }
  | { section: "stale"; page: ProgressSectionPage<ProgressStaleRow> };
