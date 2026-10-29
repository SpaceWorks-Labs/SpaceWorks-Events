import "server-only";

import crypto from "node:crypto";
import type { AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { enqueueWebhookEvent } from "@/lib/webhooks/emit";

/*
 * application.status_changed webhooks (docs/ADMISSION.md, docs/WEBHOOKS.md).
 * A trigger records every status or stage change of an application in
 * AdmissionStatusEvent, whatever made it: a released decision, an answer, a
 * settled payment, a deleted registration. After a commit (and from the beat,
 * as a safety net) each row is sent in its own transaction: the row is locked
 * (SKIP LOCKED, so two drains never take the same row), marked emitted and its
 * deliveries inserted together, each with the stage recorded at the change. A
 * crash or error before the commit leaves the row unsent for the next pass,
 * and the webhook event id is derived from the row, so a row is never queued
 * twice. Sent rows are purged after 30 days by the retention job
 * (lib/retention.ts).
 */

const BATCH = 100;

type StatusEventRow = { id: string; applicationId: string; status: AdmissionStatus; previousStatus: AdmissionStatus | null; stageId: string | null };

/** The webhook event id for one recorded change: the same on every attempt. */
export function applicationWebhookEventId(statusEventId: string) {
  return `evt_${crypto.createHash("sha256").update(`AdmissionStatusEvent:${statusEventId}`).digest("hex").slice(0, 32)}`;
}

async function sendOne(id: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<StatusEventRow[]>`
      SELECT "id", "applicationId", "status", "previousStatus", "stageId" FROM "AdmissionStatusEvent"
      WHERE "id" = ${id} AND "emittedAt" IS NULL FOR UPDATE SKIP LOCKED
    `;
    if (!row) return false;
    await tx.$executeRaw`UPDATE "AdmissionStatusEvent" SET "emittedAt" = ${SQL_UTC_NOW} WHERE "id" = ${row.id}`;
    await enqueueWebhookEvent(
      { type: "application.status_changed", applicationId: row.applicationId, status: row.status, previousStatus: row.previousStatus, stageId: row.stageId },
      { client: tx, eventId: applicationWebhookEventId(row.id) },
    );
    return true;
  });
}

export async function drainApplicationEvents(limit = BATCH): Promise<number> {
  const due = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AdmissionStatusEvent" WHERE "emittedAt" IS NULL
    ORDER BY "createdAt" ASC, "id" ASC LIMIT ${limit}
  `;
  let sent = 0;
  for (const { id } of due) {
    // A row that fails stays unsent for the next pass; the others go on.
    if (await sendOne(id).catch(() => false)) sent += 1;
  }
  return sent;
}
