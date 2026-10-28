import "server-only";

import type { AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { emitWebhookEvent } from "@/lib/webhooks/emit";

/*
 * application.status_changed webhooks (docs/ADMISSION.md, docs/WEBHOOKS.md).
 * A trigger records every status or stage change of an application in
 * AdmissionStatusEvent, whatever made it: a released decision, an answer, a
 * settled payment, a deleted registration. After a commit (and from the beat,
 * as a safety net) those rows are claimed once each and turned into webhooks,
 * so no transition is missed and none is sent twice.
 */

const BATCH = 100;

export async function drainApplicationEvents(limit = BATCH): Promise<number> {
  const claimed = await prisma.$queryRaw<Array<{ applicationId: string; status: AdmissionStatus; previousStatus: AdmissionStatus | null }>>`
    UPDATE "AdmissionStatusEvent" SET "emittedAt" = ${SQL_UTC_NOW}
    WHERE "id" IN (
      SELECT "id" FROM "AdmissionStatusEvent" WHERE "emittedAt" IS NULL
      ORDER BY "createdAt" ASC, "id" ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING "applicationId", "status", "previousStatus"
  `;
  for (const row of claimed) emitWebhookEvent({ type: "application.status_changed", applicationId: row.applicationId, status: row.status, previousStatus: row.previousStatus });
  return claimed.length;
}
