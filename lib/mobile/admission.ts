import "server-only";

import { AdmissionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveAdmissionReviewer, type AdmissionContext } from "@/lib/admission/access";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { respondAsApplicant, type RespondAction } from "@/lib/admission/respond";
import { listMyReviews, loadReviewItem, recuse, submitReview } from "@/lib/admission/reviews";
import { unitOrder } from "@/lib/admission/state";
import { loadTicketApplication } from "@/lib/admission/ticketView";
import { startCheckout } from "@/lib/payments/checkout";
import { applicationRespondDtoSchema, myApplicationDtoSchema, reviewItemDtoSchema, reviewQueueDtoSchema, reviewWriteDtoSchema } from "@/lib/mobile/schemas";

/*
 * Applications for /api/mobile/v1 (docs/ADMISSION.md, docs/MOBILE_API.md),
 * over the same cores as the web: the applicant's own registration through
 * the bearer session (the ticket token is looked up on the server, never
 * sent or returned), and the reviewer workspace as the stage allows.
 */

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** The caller's own registration on a one-off event, with its server-side ticket token. */
async function ownRegistration(userId: string, rsvpId: string) {
  if (!rsvpId || rsvpId.length > 128) return null;
  return prisma.rSVP.findFirst({ where: { id: rsvpId, userId, eventId: { not: null } }, select: { id: true, eventId: true, teamId: true, isCrew: true, checkInToken: true } });
}

/** `{ application: null }` when the registration isn't an application; null when it isn't the caller's. */
export async function loadMyApplication(userId: string, rsvpId: string) {
  const rsvp = await ownRegistration(userId, rsvpId);
  if (!rsvp) return null;
  const view = await loadTicketApplication(rsvp);
  if (!view) return myApplicationDtoSchema.parse({ application: null });
  const actions = [
    ...(view.status === AdmissionStatus.OFFERED && view.canAnswer && !view.paying ? ["accept" as const, "decline" as const] : []),
    ...(view.canWithdraw ? ["withdraw" as const] : []),
  ];
  return myApplicationDtoSchema.parse({
    application: {
      status: view.status,
      statusLabel: view.statusLabel,
      stage: view.stageName && view.stagePosition != null ? { name: view.stageName, position: view.stagePosition } : null,
      respondBy: view.respondByAt,
      teamName: view.teamName,
      isLeader: view.canAnswer,
      actions,
      paid: view.paid,
      paying: view.paying,
      answers: view.edit?.fields ?? null,
    },
  });
}

/**
 * Accept, decline or withdraw the caller's own application (the team leader
 * for a team). A paid acceptance holds the place and opens the hosted payment
 * page through the usual checkout path; the place is confirmed only by the payment.
 */
export async function respondToMyApplication(userId: string, rsvpId: string, action: RespondAction): Promise<Result<ReturnType<typeof applicationRespondDtoSchema.parse>> | null> {
  const rsvp = await ownRegistration(userId, rsvpId);
  if (!rsvp) return null;
  const result = await respondAsApplicant(rsvp.checkInToken, action);
  if (!result.ok) return result;
  let checkoutUrl: string | null = null;
  if (action === "accept" && result.paying) {
    const app = await prisma.admissionApplication.findFirst({ where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id }, select: { rsvpId: true, teamId: true } });
    const order = app ? await unitOrder(prisma, app) : null;
    const outcome = order ? await startCheckout(order.id).catch(() => null) : null;
    checkoutUrl = outcome && "url" in outcome ? outcome.url : null;
  }
  return { ok: true, data: applicationRespondDtoSchema.parse({ status: result.status, paying: result.paying, checkoutUrl }) };
}

export async function saveMyApplicationAnswers(userId: string, rsvpId: string, answers: Record<string, unknown>): Promise<Result<null> | null> {
  const rsvp = await ownRegistration(userId, rsvpId);
  if (!rsvp) return null;
  const result = await editApplicationAnswers(rsvp.checkInToken, answers);
  return result.ok ? { ok: true, data: null } : result;
}

/* ---------- Reviewers ---------- */

/** A reviewer of this event (REVIEW_APPLICATIONS or owner/admin), on an event taking applications; null otherwise. */
export async function resolveMobileReviewer(userId: string, orgSlug: string, eventId: string): Promise<AdmissionContext | null> {
  const ctx = await resolveAdmissionReviewer(userId, orgSlug, eventId);
  if (!ctx) return null;
  const event = await prisma.event.findUnique({ where: { id: ctx.eventId }, select: { admissionEnabled: true } });
  return event?.admissionEnabled ? ctx : null;
}

export async function loadReviewQueue(ctx: AdmissionContext) {
  return reviewQueueDtoSchema.parse({ reviews: await listMyReviews(ctx) });
}

export async function loadReview(ctx: AdmissionContext, assignmentId: string) {
  const item = await loadReviewItem(ctx, assignmentId);
  if (!item) return null;
  return reviewItemDtoSchema.parse({
    ...item,
    people: item.people.map((person) => ({ name: person.name, email: person.email, isLeader: person.isLeader, answers: person.answers.map((answer) => ({ label: answer.label, value: answer.value })) })),
  });
}

export async function submitMyReview(ctx: AdmissionContext, assignmentId: string, input: { scores: Record<string, unknown>; notes: string }) {
  const result = await submitReview(ctx, assignmentId, input);
  return result.ok ? { ok: true as const, data: reviewWriteDtoSchema.parse({ assignmentId, outcome: "SUBMITTED", replaced: null }) } : result;
}

export async function recuseFromMyReview(ctx: AdmissionContext, assignmentId: string) {
  const result = await recuse(ctx, assignmentId);
  return result.ok ? { ok: true as const, data: reviewWriteDtoSchema.parse({ assignmentId, outcome: "RECUSED", replaced: result.data.replacedBy }) } : result;
}
