import "server-only";

import type { AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { enqueueWebhookEvent } from "@/lib/webhooks/emit";

/*
 * application.status_changed webhooks (docs/ADMISSION.md, docs/WEBHOOKS.md).
 * A trigger records every status or stage change of an application in
 * AdmissionStatusEvent, whatever made it: a released decision, an answer, a
 * settled payment, a deleted registration. After a commit (and from the beat,
 * as a safety net) rows are claimed and queued as deliveries, each with the
 * stage recorded at the change. A row whose queueing fails is released again
 * (at least once); one queued twice by a crash between the two steps is the
 * rare duplicate receivers already handle by event id. Sent rows are purged
 * after 30 days by the retention job (lib/retention.ts).
 */

const BATCH = 100;

export async function drainApplicationEvents(limit = BATCH): Promise<number> {
  const claimed = await prisma.$queryRaw<Array<{ id: string; applicationId: string; status: AdmissionStatus; previousStatus: AdmissionStatus | null; stageId: string | null }>>`
    UPDATE "AdmissionStatusEvent" SET "emittedAt" = ${SQL_UTC_NOW}
    WHERE "id" IN (
      SELECT "id" FROM "AdmissionStatusEvent" WHERE "emittedAt" IS NULL
      ORDER BY "createdAt" ASC, "id" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING "id", "applicationId", "status", "previousStatus", "stageId"
  `;
  let sent = 0;
  for (const row of claimed) {
    try {
      await enqueueWebhookEvent({ type: "application.status_changed", applicationId: row.applicationId, status: row.status, previousStatus: row.previousStatus, stageId: row.stageId });
      sent += 1;
    } catch {
      // Not queued: release the row for the next pass.
      await prisma.admissionStatusEvent.updateMany({ where: { id: row.id }, data: { emittedAt: null } }).catch(() => undefined);
    }
  }
  return sent;
}
