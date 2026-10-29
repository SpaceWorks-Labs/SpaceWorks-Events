import "server-only";

import { OutboxStatus, WebhookDeliveryStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { purgeUnusedCrewPhotos } from "@/lib/core/crew/photos";
import { purgeUnattachedReceipts } from "@/lib/storage/deletionQueue";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEBHOOK_EVENT_RETENTION_DAYS = 90;
/** A day past the 7 days an offline check-in is accepted, so a deleted record can never be replayed. */
const OFFLINE_CHECK_IN_RECORD_DAYS = 8;

/** Remove expired operational records without deleting business/audit data. */
export async function purgeExpiredOperationalData(now = new Date()) {
  const outboxRetentionDays = Math.min(
    Math.max(Number(process.env.OUTBOX_RETENTION_DAYS || 30), 1),
    365,
  );
  const sentBefore = new Date(now.getTime() - outboxRetentionDays * DAY_MS);
  const webhookBefore = new Date(now.getTime() - 30 * DAY_MS);
  const [tokens, sessions, organisationInvites, collaboratorInvites, undoSnapshots, sentMessages, failedMessages, webhookEvents, webhookDeliveries, mobileSessions, idempotencyKeys, applicationEvents, offlineCheckIns] = await prisma.$transaction([
    prisma.verificationToken.deleteMany({ where: { expires: { lt: now } } }),
    prisma.session.deleteMany({ where: { expires: { lt: now } } }),
    prisma.organisationInvite.deleteMany({ where: { usedAt: null, expiresAt: { lt: now } } }),
    prisma.eventCollaboratorInvite.deleteMany({ where: { usedAt: null, expiresAt: { lt: now } } }),
    prisma.rsvpDeletionUndo.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.outboxMessage.deleteMany({
      where: { status: OutboxStatus.SENT, sentAt: { lt: sentBefore } },
    }),
    prisma.outboxMessage.deleteMany({
      where: { status: OutboxStatus.FAILED, createdAt: { lt: sentBefore } },
    }),
    // Providers stop redelivering after a few days, so old idempotency keys are inert.
    prisma.processedWebhookEvent.deleteMany({
      where: { processedAt: { lt: new Date(now.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * DAY_MS) } },
    }),
    // Organisation webhook delivery log: 30 days. Retries finish within about
    // a day, so only rows still under a worker lease are kept.
    prisma.webhookDelivery.deleteMany({
      where: { createdAt: { lt: webhookBefore }, status: { not: WebhookDeliveryStatus.PROCESSING } },
    }),
    // Mobile app sessions past their refresh lifetime, or revoked a week ago.
    prisma.mobileSession.deleteMany({
      where: { OR: [{ refreshExpiresAt: { lt: now } }, { revokedAt: { lt: new Date(now.getTime() - 7 * DAY_MS) } }] },
    }),
    // Mobile idempotency keys past their day.
    prisma.mobileIdempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } }),
    // Application status changes already sent as webhooks (docs/ADMISSION.md): 30 days.
    prisma.admissionStatusEvent.deleteMany({ where: { emittedAt: { not: null, lt: webhookBefore } } }),
    // Offline check-in replay records (app/actions/checkin/offline.ts): past the acceptance window.
    prisma.offlineCheckInMutation.deleteMany({ where: { checkedInAt: { lt: new Date(now.getTime() - OFFLINE_CHECK_IN_RECORD_DAYS * DAY_MS) } } }),
  ]);
  // Crew photos nobody saved within a day (docs/CREW.md); objects too, so outside the transaction.
  const unusedCrewPhotos = await purgeUnusedCrewPhotos(now);
  // Receipt photos no claim refers to after a day; their objects are queued for deletion.
  const unattachedReceipts = await purgeUnattachedReceipts(now);
  return {
    verificationTokens: tokens.count,
    expiredSessions: sessions.count,
    unusedOrganisationInvites: organisationInvites.count,
    unusedCollaboratorInvites: collaboratorInvites.count,
    undoSnapshots: undoSnapshots.count,
    sentOutboxMessages: sentMessages.count,
    failedOutboxMessages: failedMessages.count,
    processedWebhookEvents: webhookEvents.count,
    webhookDeliveries: webhookDeliveries.count,
    mobileSessions: mobileSessions.count,
    idempotencyKeys: idempotencyKeys.count,
    applicationStatusEvents: applicationEvents.count,
    offlineCheckInRecords: offlineCheckIns.count,
    unusedCrewPhotos,
    unattachedReceipts,
  };
}
