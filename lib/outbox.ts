import "server-only";

/**
 * The transactional outbox: request handlers queue email in their own
 * transaction, and the worker delivers it. The parts live in lib/outbox/.
 */
export * from "./outbox/enqueue";
export { deliverOutboxBatch } from "./outbox/deliver";
export { EVENT_REMINDER_KIND, type EventReminderPayload, type OperatorNoticePayload } from "./outbox/payloads";
export { asTeamCreatedPayload, asTeamMemberAddedPayload, enqueueTeamCreated, enqueueTeamMemberAdded, type TeamCreatedPayload, type TeamMemberAddedPayload } from "./outbox/team";
