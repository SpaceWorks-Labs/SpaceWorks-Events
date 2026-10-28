import "server-only";

import { AdmissionEntrySource, AdmissionStatus, RsvpStatus, type Prisma } from "@prisma/client";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { applicationChanged, queueNotice } from "./notify";
import { respondByFor } from "./rules";
import { AdmissionError, cancelUnpaidOrder, setUnitStatus, updateApplication, type AdmissionEvent, type ApplicationRow } from "./state";

/*
 * The state changes of an application (docs/ADMISSION.md), each inside the
 * caller's transaction under the Event lock. Each one moves the application
 * and its registrations together, queues the applicant's email and returns
 * the webhooks to emit after commit. Nothing here takes money: an offer of a
 * paid place leaves the order REQUESTED until the applicant accepts and pays.
 */

type Change = { tx: Prisma.TransactionClient; event: AdmissionEvent; app: ApplicationRow; now: Date };

const lockAnswers = (app: ApplicationRow, now: Date) => (app.answersLockedAt ? {} : { answersLockedAt: now });

/** Offer a place: OFFERED until respondBy; the registrations stay pending (nothing is held or charged). */
export async function offerPlace({ tx, event, app, now }: Change): Promise<WebhookEmission[]> {
  const respondBy = respondByFor(now, event.admissionRsvpDays, event.startDateTime);
  await updateApplication(tx, app, { status: AdmissionStatus.OFFERED, offeredAt: now, respondBy, queuedAt: null, skipReason: null, offerReminderSentAt: null, decisionRevision: { increment: 1 }, ...lockAnswers(app, now) });
  const registrations = await setUnitStatus(tx, app, RsvpStatus.PENDING_APPROVAL);
  await queueNotice(tx, event.organisationId, app, "offer", app.decisionRevision + 1);
  return [...registrations, applicationChanged(app.id, app.status, AdmissionStatus.OFFERED)];
}

export async function waitlistApplication({ tx, event, app, now }: Change): Promise<WebhookEmission[]> {
  await updateApplication(tx, app, { status: AdmissionStatus.WAITLISTED, queuedAt: app.queuedAt ?? now, respondBy: null, decisionRevision: { increment: 1 }, ...lockAnswers(app, now) });
  const registrations = await setUnitStatus(tx, app, RsvpStatus.WAITLISTED);
  await queueNotice(tx, event.organisationId, app, "waitlisted", app.decisionRevision + 1);
  return [...registrations, applicationChanged(app.id, app.status, AdmissionStatus.WAITLISTED)];
}

export async function rejectApplication({ tx, event, app, now }: Change): Promise<WebhookEmission[]> {
  await updateApplication(tx, app, { status: AdmissionStatus.REJECTED, queuedAt: null, respondBy: null, decisionRevision: { increment: 1 }, ...lockAnswers(app, now) });
  const registrations = await setUnitStatus(tx, app, RsvpStatus.REJECTED);
  await cancelUnpaidOrder(tx, app);
  await queueNotice(tx, event.organisationId, app, "rejected", app.decisionRevision + 1);
  return [...registrations, applicationChanged(app.id, app.status, AdmissionStatus.REJECTED)];
}

/** Move an application in review to the stage after its current one. */
export async function advanceApplication({ tx, event, app, now }: Change, params: { actorUserId: string | null; sourceRank: number | null }): Promise<WebhookEmission[]> {
  const current = app.currentStageId ? await tx.admissionStage.findUnique({ where: { id: app.currentStageId }, select: { position: true } }) : null;
  const next = await tx.admissionStage.findFirst({ where: { eventId: event.id, position: { gt: current?.position ?? 0 } }, orderBy: { position: "asc" }, select: { id: true } });
  if (!next) throw new AdmissionError("This is the last stage, so the application can't move on. Offer a place, waitlist or decline it instead.");
  await tx.admissionStageEntry.create({ data: { stageId: next.id, applicationId: app.id, source: AdmissionEntrySource.ADVANCED, advancedByUserId: params.actorUserId, advancedAt: now, sourceRank: params.sourceRank } });
  await updateApplication(tx, app, { currentStageId: next.id, decisionRevision: { increment: 1 }, ...lockAnswers(app, now) });
  if (event.emailApplicantsOnStageAdvance) await queueNotice(tx, event.organisationId, app, "stage-advanced", app.decisionRevision + 1);
  return [applicationChanged(app.id, app.status, app.status)];
}

/**
 * Close an application for good (DECLINED by the applicant, EXPIRED when
 * the offer ran out, WITHDRAWN): its registrations are declined and an unpaid
 * order is cancelled. Only EXPIRED is emailed; the applicant chose the others.
 */
export async function closeApplication({ tx, event, app }: Change, to: "DECLINED" | "EXPIRED" | "WITHDRAWN"): Promise<WebhookEmission[]> {
  await updateApplication(tx, app, { status: to, queuedAt: null, decisionRevision: { increment: to === "EXPIRED" ? 1 : 0 } });
  const registrations = await setUnitStatus(tx, app, RsvpStatus.REJECTED);
  await cancelUnpaidOrder(tx, app);
  if (to === "EXPIRED") await queueNotice(tx, event.organisationId, app, "expired", app.decisionRevision + 1);
  return [...registrations, applicationChanged(app.id, app.status, to)];
}
