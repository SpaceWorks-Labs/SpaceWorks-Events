import "server-only";

import { AdmissionMode, AdmissionStatus, EventStatus, OrderStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { emitAll, queueNotice } from "./notify";
import { reopenEndedHold } from "./payment";
import { autoDecide, promoteWaitlisted } from "./promotion";
import { OFFER_REMINDER_BEFORE_MS } from "./rules";
import { applicationSelect, lockAdmissionEvent, unitMembers } from "./state";
import { closeApplication } from "./transitions";

/*
 * The beat's admission pass (docs/ADMISSION.md), safe to run twice or from
 * two processes at once: every change re-reads the application under the
 * Event lock and is guarded by its version.
 *
 * 1. A payment hold that ended unpaid: the offer stands again while its
 *    respond-by time lasts; otherwise it expires and the order is cancelled.
 * 2. Offers past their respond-by time expire (not while a payment hold is
 *    still live: the payment may yet land).
 * 3. One reminder per offer, a day before it ends.
 * 4. AUTO events decide new applications; every event's waitlist is offered
 *    any free places.
 *
 * A cancelled event gets no reopened offers, reminders or new offers: only
 * its ended offers expire.
 */

const BATCH = 50;
/** An offer this young gets no reminder (a one-day offer would be reminded at once). */
const REMINDER_MIN_AGE_MS = 12 * 60 * 60_000;

async function settleOffer(applicationId: string, now: Date, webhooks: WebhookEmission[]): Promise<"expired" | "reopened" | null> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.admissionApplication.findUnique({ where: { id: applicationId }, select: { eventId: true } });
    if (!row) return null;
    const event = await lockAdmissionEvent(tx, row.eventId);
    const app = await tx.admissionApplication.findUnique({ where: { id: applicationId }, select: applicationSelect });
    if (!event || !app || app.status !== AdmissionStatus.OFFERED) return null;
    const members = await unitMembers(tx, app);
    if (members.some((member) => member.status === RsvpStatus.PENDING_PAYMENT && member.holdExpiresAt && member.holdExpiresAt > now)) return null;
    if (app.respondBy && app.respondBy > now) return event.status !== EventStatus.CANCELLED && (await reopenEndedHold(tx, app)) ? "reopened" : null;
    webhooks.push(...(await closeApplication({ tx, event, app, now }, AdmissionStatus.EXPIRED)));
    return "expired";
  }, { timeout: 20_000, maxWait: 10_000 });
}

export async function runAdmissionMaintenance(now = new Date()) {
  const webhooks: WebhookEmission[] = [];
  const touched = new Set<string>();
  let expired = 0;
  let reopened = 0;
  let reminded = 0;

  const due = await prisma.admissionApplication.findMany({
    where: {
      status: AdmissionStatus.OFFERED,
      OR: [
        { respondBy: { lte: now } },
        { rsvp: { order: { status: OrderStatus.EXPIRED } }, event: { status: { not: EventStatus.CANCELLED } } },
        { team: { orders: { some: { teamName: { not: null }, status: OrderStatus.EXPIRED } } }, event: { status: { not: EventStatus.CANCELLED } } },
      ],
    },
    select: { id: true, eventId: true },
    orderBy: { respondBy: "asc" },
    take: BATCH,
  });
  for (const row of due) {
    const outcome = await settleOffer(row.id, now, webhooks).catch(() => null);
    if (outcome === "expired") expired += 1;
    if (outcome === "reopened") reopened += 1;
    if (outcome) touched.add(row.eventId);
  }

  const remind = await prisma.admissionApplication.findMany({
    where: { status: AdmissionStatus.OFFERED, offerReminderSentAt: null, event: { status: { not: EventStatus.CANCELLED } }, respondBy: { gt: now, lte: new Date(now.getTime() + OFFER_REMINDER_BEFORE_MS) }, offeredAt: { lte: new Date(now.getTime() - REMINDER_MIN_AGE_MS) } },
    select: { id: true, rsvpId: true, teamId: true, decisionRevision: true, event: { select: { organisationId: true } } },
    take: BATCH,
  });
  for (const app of remind) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.admissionApplication.updateMany({ where: { id: app.id, status: AdmissionStatus.OFFERED, offerReminderSentAt: null }, data: { offerReminderSentAt: now } });
      if (claimed.count !== 1) return;
      await queueNotice(tx, app.event.organisationId, app, "reminder", app.decisionRevision);
      reminded += 1;
    });
  }

  const auto = await prisma.event.findMany({ where: { admissionEnabled: true, status: { not: EventStatus.CANCELLED }, admissionMode: AdmissionMode.AUTO, startDateTime: { gt: now }, admissionApplications: { some: { status: AdmissionStatus.IN_REVIEW } } }, select: { id: true }, take: BATCH });
  for (const event of auto) {
    await autoDecide(event.id, now).catch(() => 0);
    touched.add(event.id);
  }
  const waiting = await prisma.event.findMany({ where: { admissionEnabled: true, status: { not: EventStatus.CANCELLED }, startDateTime: { gt: now }, admissionApplications: { some: { status: AdmissionStatus.WAITLISTED } } }, select: { id: true }, take: BATCH });
  let promoted = 0;
  for (const event of new Set([...touched, ...waiting.map((row) => row.id)])) promoted += await promoteWaitlisted(event, now).catch(() => 0);

  await emitAll(webhooks);
  return { expired, reopened, reminded, promoted };
}
