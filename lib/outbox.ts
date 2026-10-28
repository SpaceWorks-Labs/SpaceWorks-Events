import "server-only";

/**
 * The transactional outbox: request handlers queue email in their own
 * transaction, and the worker delivers it. The parts live in lib/outbox/.
 */
export * from "./outbox/enqueue";
export { deliverOutboxBatch, deliverOutboxBatchWithCount } from "./outbox/deliver";
export { BULK_OUTBOX_KINDS } from "./outbox/due";
export { EVENT_REMINDER_KIND, type EventReminderPayload, type OperatorNoticePayload } from "./outbox/payloads";
export { asTeamCreatedPayload, asTeamMemberAddedPayload, enqueueTeamCreated, enqueueTeamMemberAdded, type TeamCreatedPayload, type TeamMemberAddedPayload } from "./outbox/team";
export { asFinalistsAnnouncedPayload, FINALISTS_ANNOUNCED_KIND, type FinalistsAnnouncedPayload } from "./outbox/finalists";
export { asResultsPublishedPayload, asSubmissionLinkPayload, asSubmissionReceivedPayload, enqueueResultsPublished, enqueueSubmissionLink, enqueueSubmissionReceived, type ResultsPublishedPayload, type SubmissionLinkPayload, type SubmissionReceivedPayload } from "./outbox/judging";
