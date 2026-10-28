import "server-only";

import type { JudgingRoundEntrySource, JudgingRoundStatus, ScoreNormalization } from "@prisma/client";
import { loadJudgingRounds, type JudgingRoundDto } from "@/lib/core/judgingRounds";
import type { JudgingOrganiserContext } from "@/lib/judgingAccess";
import type { JudgingDashboardCriterion } from "./judging";

/*
 * Judging → Rounds data for client components (docs/HACKATHON.md "Rounds"):
 * dates as ISO strings, judges by user id only (names come from the
 * dashboard's judge list, which organisers already see).
 */

export type JudgingDashboardRound = {
  id: string;
  name: string;
  position: number;
  status: JudgingRoundStatus;
  entrySource: JudgingRoundEntrySource;
  judgesSeeAll: boolean;
  freshEyes: boolean;
  reviewsPerProject: number | null;
  scoreNormalization: ScoreNormalization;
  opensAt: string | null;
  closesAt: string | null;
  finalistsPublishedAt: string | null;
  finalizedAt: string | null;
  isCurrent: boolean;
  isFinal: boolean;
  panelUserIds: string[];
  criteria: JudgingDashboardCriterion[];
  finalists: number;
  reviewsSubmitted: number;
};

export function toDashboardRound(round: JudgingRoundDto): JudgingDashboardRound {
  return {
    ...round,
    opensAt: round.opensAt?.toISOString() ?? null,
    closesAt: round.closesAt?.toISOString() ?? null,
    finalistsPublishedAt: round.finalistsPublishedAt?.toISOString() ?? null,
    finalizedAt: round.finalizedAt?.toISOString() ?? null,
    panelUserIds: [...round.panelUserIds],
    criteria: round.criteria.map((criterion) => ({ ...criterion })),
  };
}

/** Every round of the event for the Rounds tab and the round switchers; empty when there is none yet. */
export async function loadDashboardRounds(organiser: JudgingOrganiserContext): Promise<JudgingDashboardRound[]> {
  return ((await loadJudgingRounds(organiser)) ?? []).map(toDashboardRound);
}
