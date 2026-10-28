import "server-only";

/**
 * Hackathon submission, judging, and results cores (docs/HACKATHON.md),
 * shared by Server Actions and route handlers. Callers authenticate the
 * capability or session, rate limit, and revalidate; these functions own the
 * rules and write the audit events the spec requires (settings, judging
 * status, disqualification, reinstatement, results publication) in the same
 * transaction as the change.
 *
 * Every id from a browser is re-read together with its `eventId`, and the
 * event together with its `organisationId`. Entrant authority (management
 * token, team membership, RSVP ownership, or submission link) is re-checked
 * inside the write transaction, and the submission window is compared with
 * server time there too.
 *
 * Locking: entrant and judge writes take `FOR SHARE` on the Event row;
 * organiser changes take `FOR UPDATE`. So closing the window, freezing the
 * rubric, or closing judging serialises with in-flight submissions and scores.
 *
 * The parts live in lib/core/judging/; this file is their public entry.
 */

export { type JudgingResult, type EntrantAuth, isSubmissionWindowOpen, isProjectGalleryVisible, JUDGING_EXPORT_BATCH_SIZE } from "./judging/shared";
export { resolveEntrantByTeamManageToken, resolveEntrantForUser, resolveEntrantBySubmissionLink } from "./judging/entrantAuth";
export { saveSubmissionDraft, submitSubmission, withdrawSubmission, loadEntrantSubmission, requestSubmissionLink } from "./judging/entrantSubmissions";
export {
  type JudgingSettingsDto,
  submissionsLockedOnReason,
  updateJudgingSettings,
  createJudgingCriterion,
  updateJudgingCriterion,
  deleteJudgingCriterion,
  reorderJudgingCriteria,
  type OrganiserAwardDto,
  type JudgingSetupDto,
  loadJudgingSetup,
} from "./judging/settings";
export { createEventAward, updateEventAward, deleteEventAward, reorderEventAwards, setAwardWinner, removeAwardWinner } from "./judging/awards";
export { disqualifySubmission, reinstateSubmission } from "./judging/disqualification";
export {
  type ConflictKeys,
  conflictKeysFor,
  hasConflictOfInterest,
  type EligibleJudgeDto,
  listEligibleJudges,
  assignJudge,
  unassignJudge,
} from "./judging/judges";
export { setJudgingStatus, setScoreNormalization, type PublishResultsOutcome, publishResults, unpublishResults } from "./judging/status";
export { type SendResultsAnnouncementOutcome, sendResultsAnnouncement, countResultsAnnouncementRecipients } from "./judging/announcement";
export { listSubmissionsForJudge, listJudgeSubmissionsPage, loadSubmissionForJudge, type JudgeNextDto, nextSubmissionForJudge } from "./judging/judgeWorkspace";
export { type RecusedProjectDto, setJudgeRecusal } from "./judging/recusal";
export { saveJudgeScores, submitJudgeReview } from "./judging/judgeScoring";
export {
  type OrganiserSubmissionsPage,
  listSubmissionsForOrganiser,
  type OrganiserReviewDto,
  loadSubmissionReviewsForOrganiser,
} from "./judging/organiserSubmissions";
export {
  type ResultRowDto,
  type JudgeProgressDto,
  type JudgingResultsDto,
  loadJudgingResults,
  type JudgingResultsPageDto,
  loadJudgingResultsPage,
  type AwardCandidateDto,
  searchAwardCandidates,
} from "./judging/results";
export { type JudgeProgressRowDto, loadJudgeProgress } from "./judging/judgeProgress";
export {
  type CsvExportPlan,
  type JudgingResultsExportView,
  planJudgingResultsExport,
  buildJudgingExportRows,
  type JudgingSubmissionsExportView,
  planJudgingSubmissionsExport,
} from "./judging/exports";
export { loadPublicResults, type ProjectGalleryQuery, loadProjectGallery } from "./judging/publicPages";
