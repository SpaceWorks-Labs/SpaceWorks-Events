import { MinHeap, pairKey, planAssignments, plannerFingerprint, seededTie, tieHash, type PlannerPair } from "@/lib/assignmentPlanner";
import { AUTO_ASSIGN_MODES, type AutoAssignMode } from "@/lib/judgingProgress";

/*
 * Automatic judge assignment (docs/HACKATHON.md, "Automatic assignment"), as
 * pure functions so the rules are unit tested without a database
 * (tests/unit/judging-assignment.test.ts). The core in lib/core/judgingOps.ts
 * reads the event, builds the input, and writes the plan.
 *
 * Rules:
 * - Every SUBMITTED project should end up with `perProject` judges from the
 *   pool. The pool is the judges the organiser picked: JUDGE collaborators
 *   are in it by default, organisation owners and admins only when the
 *   organiser opts them in. The core checks every pool member can judge.
 * - A judge is never given a project they have a conflict of interest with
 *   (`blocked`, the same rule as the judge's own list).
 * - "keep" leaves every existing assignment alone; a kept assignment counts
 *   towards the project's target when its judge may judge it (`countable`).
 *   "replace" removes existing assignments, except where that judge has
 *   already scored or reviewed the project (`started`), which are kept and
 *   counted the same way. A replace re-run that would remove an assignment
 *   and add it straight back leaves it alone, so an unchanged event plans no
 *   changes in either mode.
 * - Work a judge did without an assignment (possible while judges see every
 *   project) is never ignored. When `adoptStarted` is set (judges see every
 *   project now, and applying switches that off) each started pair by a judge
 *   who may judge it becomes an assignment (`adopt`), counts towards the
 *   target and towards the judge's load, so the judge keeps access to their
 *   own work. Otherwise a submitted review by such a judge still counts
 *   towards the target (it counts in Results) and that judge isn't picked for
 *   the project again.
 * - Load is balanced with a min-heap on each judge's current load (kept and
 *   new assignments on SUBMITTED projects). Ties break on a hash of the judge
 *   and project ids, then the judge id, so the same input always gives the
 *   same plan and ties don't always favour the same judge.
 * - Projects with the fewest possible judges go first, so a project with
 *   many conflicts isn't starved by easier ones. A project that can't reach
 *   the target is reported as a shortfall.
 *
 * The planner itself is shared with admission review (lib/assignmentPlanner.ts);
 * this module maps judges and projects onto it, unchanged.
 */

export { AUTO_ASSIGN_MODES, type AutoAssignMode };

export type AssignmentPair = { judgeUserId: string; submissionId: string };

export type AutoAssignInput = {
  /** SUBMITTED project ids. */
  projectIds: readonly string[];
  /** The judges to assign from (already checked as eligible). */
  poolJudgeIds: readonly string[];
  /** Target judges per project. */
  perProject: number;
  mode: AutoAssignMode;
  /** Every current assignment on the event's SUBMITTED projects. */
  existing: readonly AssignmentPair[];
  /** `pairKey(judge, project)` for conflicts of interest. */
  blocked: ReadonlySet<string>;
  /** `pairKey` of every judge/project pair with saved scores or a review row (draft or submitted), assigned or not. */
  started: ReadonlySet<string>;
  /** `pairKey` of pairs with a submitted review (a subset of `started`). */
  submitted?: ReadonlySet<string>;
  /** Turn started, unassigned pairs into assignments (judges currently see every project). */
  adoptStarted?: boolean;
  /** Whether an existing assignment's judge can still judge the event (counts towards the target). */
  canJudge: (judgeUserId: string) => boolean;
  /**
   * RANDOM runs: a seed (32 hex characters) that replaces the fixed tie hash
   * with a seeded one. Load balance, conflicts and the target rule work
   * exactly as for BALANCED runs; only which of the equally loaded judges
   * (and equally constrained projects) comes first depends on the seed.
   */
  seed?: string | null;
};

/**
 * Projects on each pool judge's plate: now (assignments on SUBMITTED projects,
 * plus started projects that become assignments), added, removed (replace
 * mode), and after the plan. `before + added - removed = after`.
 */
export type JudgeLoad = { judgeUserId: string; before: number; added: number; removed: number; after: number };
export type ProjectShortfall = { submissionId: string; assigned: number; missing: number; possible: number };

export type AutoAssignPlan = {
  add: AssignmentPair[];
  remove: AssignmentPair[];
  /** Started, unassigned pairs that become assignments so their judge keeps access. */
  adopt: AssignmentPair[];
  /** Pool judges, in pool order. */
  loads: JudgeLoad[];
  shortfalls: ProjectShortfall[];
  /** Projects that reach the target. */
  covered: number;
  /** Short digest of the add and remove lists, so applying can refuse a plan that changed since the preview. */
  fingerprint: string;
};

export { MinHeap, pairKey, seededTie, tieHash };

const toPlanner = (pair: AssignmentPair): PlannerPair => ({ reviewerId: pair.judgeUserId, itemId: pair.submissionId });
const fromPlanner = (pair: PlannerPair): AssignmentPair => ({ judgeUserId: pair.reviewerId, submissionId: pair.itemId });

export function planFingerprint(
  add: readonly AssignmentPair[],
  remove: readonly AssignmentPair[],
  perProject: number,
  mode: AutoAssignMode,
  adopt: readonly AssignmentPair[] = [],
  seed: string | null = null,
): string {
  return plannerFingerprint(add.map(toPlanner), remove.map(toPlanner), perProject, mode, adopt.map(toPlanner), seed);
}

/** Build the assignment plan. Pure and deterministic: the same input gives the same plan. */
export function planAutoAssignment(input: AutoAssignInput): AutoAssignPlan {
  const plan = planAssignments({
    itemIds: input.projectIds,
    poolReviewerIds: input.poolJudgeIds,
    perItem: input.perProject,
    mode: input.mode,
    existing: input.existing.map(toPlanner),
    blocked: input.blocked,
    started: input.started,
    submitted: input.submitted,
    adoptStarted: input.adoptStarted,
    canReview: input.canJudge,
    seed: input.seed,
  });
  return {
    add: plan.add.map(fromPlanner),
    remove: plan.remove.map(fromPlanner),
    adopt: plan.adopt.map(fromPlanner),
    loads: plan.loads.map((load) => ({ judgeUserId: load.reviewerId, before: load.before, added: load.added, removed: load.removed, after: load.after })),
    shortfalls: plan.shortfalls.map((row) => ({ submissionId: row.itemId, assigned: row.assigned, missing: row.missing, possible: row.possible })),
    covered: plan.covered,
    fingerprint: plan.fingerprint,
  };
}
