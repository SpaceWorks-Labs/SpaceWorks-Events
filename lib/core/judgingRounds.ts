import "server-only";

/**
 * Judging rounds and finalist advancement (docs/HACKATHON.md "Rounds"):
 * the public entry to lib/core/judging/rounds/. Organiser cores take a
 * `JudgingOrganiserContext` (owners and admins), lock the Event row, and
 * audit; the read models re-scope every id to the organisation's event.
 */

export { type JudgingRoundScope, judgingStatusFor, roundStatusFor } from "./judging/rounds/scope";
export { createJudgingRound, updateJudgingRound, deleteJudgingRound, reorderJudgingRounds, setJudgingRoundPanel, setJudgingRoundStatus } from "./judging/rounds/manage";
export { FINALIZE_REASON_MAX_LENGTH, type RoundCoverageDto, finalizeJudgingRound, unfinalizeJudgingRound } from "./judging/rounds/finalize";
export { type AdvancementCandidateDto, type AdvancementPreviewDto, previewAdvancement, applyAdvancement } from "./judging/rounds/advance";
export { entrantJudgingEmailsEnabled, publishFinalists, unpublishFinalists, type PublicFinalistsDto, loadPublicFinalists } from "./judging/rounds/finalists";
export { type JudgingRoundDto, loadJudgingRounds, type RoundFinalistDto, loadRoundFinalists } from "./judging/rounds/read";
