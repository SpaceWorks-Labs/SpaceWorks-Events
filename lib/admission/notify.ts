import "server-only";

import type { Prisma } from "@prisma/client";
import type { AdmissionNoticeKind } from "@/lib/email/admission";
import { enqueueAdmissionNotices } from "@/lib/outbox/admission";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import { drainApplicationEvents } from "./statusEvents";
import { personEmailOf, personNameOf, unitMembers, type ApplicationRow } from "./state";

/*
 * Application emails and webhooks (docs/ADMISSION.md, docs/WEBHOOKS.md).
 * Notices are queued in the caller's transaction, one per registration of
 * the application with an address; webhooks are collected and emitted only
 * after the transaction commits (`emitAll`).
 */

/** Queue `notice` for every person of the application, tagged with its decision revision as it is now. */
export async function queueNotice(
  tx: Prisma.TransactionClient,
  organisationId: string,
  app: Pick<ApplicationRow, "id" | "rsvpId" | "teamId">,
  notice: AdmissionNoticeKind,
  revision: number,
): Promise<void> {
  const members = await unitMembers(tx, app);
  const seen = new Set<string>();
  const payloads = [];
  for (const member of members) {
    const to = personEmailOf(member);
    if (!to || seen.has(to.toLowerCase())) continue;
    seen.add(to.toLowerCase());
    const name = personNameOf(member);
    payloads.push({ to, organisationId, applicationId: app.id, rsvpId: member.id, notice, revision, ...(name ? { recipientName: name.slice(0, 200) } : {}) });
  }
  await enqueueAdmissionNotices(tx, payloads);
}

/**
 * Emit collected registration webhooks and the application changes recorded
 * by the database (lib/admission/statusEvents.ts); call only after the
 * transaction committed.
 */
export async function emitAll(emissions: readonly WebhookEmission[]): Promise<void> {
  for (const emission of emissions) emitWebhookEvent(emission);
  await drainApplicationEvents().catch(() => 0);
}
