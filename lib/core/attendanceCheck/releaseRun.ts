import "server-only";

import { RefundRequestStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, organiserEmails } from "@/lib/notices";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";
import { ALREADY_REQUESTED, requestRefundForOrder } from "@/lib/refundRequests";
import { PaymentOperationError } from "@/lib/payments/operations/shared";
import { cancelOrderAsBuyer } from "@/lib/payments/operations/refund";
import { ATTENDANCE_RELEASE_OUTCOME_LABELS, type AttendanceReleaseOutcome } from "@/lib/attendanceCheck";
import { ATTENDANCE_AUDIT } from "./shared";
import type { ReleasePlan } from "./release";

/** What the guest reads when their "No" did not release the place. */
export function keptMessage(outcome: AttendanceReleaseOutcome): string {
  switch (outcome) {
    case "multiTicket":
    case "notBuyer":
      return "Your ticket was paid for on an order the organisers manage, so nothing was cancelled automatically.";
    case "refundRequested":
      return "The event's refund window has closed, so your place is kept and the organisers have been asked to consider a refund.";
    case "failed":
      return "Your place could not be released automatically.";
  }
}

const HANDLED_REQUEST = "The event's refund window has closed, so your place is kept. Your earlier refund request has already been handled, so contact the organisers if anything has changed.";

type Notice = { organisationId: string; eventId: string; eventTitle: string; rsvpId: string; guestName: string; outcome: AttendanceReleaseOutcome; };

/**
 * A "No" whose paid place is kept for the organisers (several tickets on the
 * order, bought by someone else, or a refund request already handled):
 * owners and admins are emailed and the chat hears it as a cancellation.
 * Called once per check (`organisersNotifiedAt`), inside the transaction
 * that sets it. Names only; never the guest's note or any link.
 */
export async function notifyOrganisersOfKeptPlace(tx: Prisma.TransactionClient, params: Notice) {
  const line = `${params.guestName} answered No to "Are you still coming?" for ${params.eventTitle}. ${ATTENDANCE_RELEASE_OUTCOME_LABELS[params.outcome]}`;
  await noticeEach(tx, await organiserEmails(tx, params.organisationId), {
    organisationId: params.organisationId,
    subject: noticeSubject("Said No", params.eventTitle),
    lines: [line, "They show as \"Said No · paid\" in the event's Guests tab."],
  });
  await notifyChat(tx, params.organisationId, "cancellation", `${params.guestName} said they can't come to ${params.eventTitle}; their paid place is kept for you to handle.`);
  await recordAuditEvent({
    action: ATTENDANCE_AUDIT.keptPaid, organisationId: params.organisationId, targetType: "Event", targetId: params.eventId,
    metadata: { rsvpId: params.rsvpId, outcome: params.outcome }, client: tx,
  });
}

export type CheckForRelease = {
  id: string; rsvpId: string; eventId: string;
  organisersNotifiedAt: Date | null; refundRequestOpenedAt: Date | null; refundRequestId: string | null;
  rsvp: { userId: string | null; checkInToken: string; };
  event: { title: string; organisationId: string; };
};

async function recordOutcome(checkId: string, outcome: AttendanceReleaseOutcome) {
  // Only while the answer is still No (the guest may have changed it meanwhile).
  await prisma.attendanceCheck.updateMany({ where: { id: checkId, response: "NOT_ATTENDING" }, data: { releaseOutcome: outcome } });
}

async function released(check: CheckForRelease, paid: boolean) {
  await recordAuditEvent({
    action: ATTENDANCE_AUDIT.released, actorUserId: check.rsvp.userId, organisationId: check.event.organisationId,
    targetType: "Event", targetId: check.eventId, metadata: { rsvpId: check.rsvpId, paid },
  });
  return { released: true as const };
}

async function failed(check: CheckForRelease, message: string) {
  await recordOutcome(check.id, "failed");
  return { released: false as const, message };
}

/**
 * A closed policy: one refund request per check, ever (`refundRequestOpenedAt`).
 * A later "No" while that request is still open changes nothing; once it has
 * been decided or withdrawn, organisers are told instead (once).
 */
async function refundRequestOnce(check: CheckForRelease, orderId: string, note: string, guestName: string, now: Date) {
  if (check.refundRequestOpenedAt) {
    const request = check.refundRequestId ? await prisma.refundRequest.findUnique({ where: { id: check.refundRequestId }, select: { status: true } }) : null;
    await recordOutcome(check.id, "refundRequested");
    if (request?.status === RefundRequestStatus.OPEN) return { released: false as const, message: keptMessage("refundRequested") };
    await prisma.$transaction(async (tx) => {
      const first = await tx.attendanceCheck.updateMany({ where: { id: check.id, organisersNotifiedAt: null }, data: { organisersNotifiedAt: now } });
      if (first.count === 1) await notifyOrganisersOfKeptPlace(tx, { organisationId: check.event.organisationId, eventId: check.eventId, eventTitle: check.event.title, rsvpId: check.rsvpId, guestName, outcome: "refundRequested" });
    });
    return { released: false as const, message: HANDLED_REQUEST };
  }
  // The guest's note goes to the organisers with the request (Finance).
  const reason = `Answered No to attendance confirmation for ${check.event.title}${note ? `: ${note}` : "."}`.slice(0, 1000);
  const result = await requestRefundForOrder(orderId, reason, (tx, requestId) => tx.attendanceCheck.updateMany({ where: { id: check.id }, data: { refundRequestId: requestId, refundRequestOpenedAt: now } }));
  // An open request on the order (the buyer's own) already reaches the organisers.
  if (!result.ok && result.error !== ALREADY_REQUESTED) return failed(check, result.error);
  if (!result.ok) {
    // The buyer's own open request stands for this check: a later No or Yes follows that one.
    const open = await prisma.refundRequest.findFirst({ where: { orderId, status: RefundRequestStatus.OPEN }, select: { id: true } });
    await prisma.attendanceCheck.updateMany({ where: { id: check.id }, data: { refundRequestOpenedAt: now, refundRequestId: open?.id ?? null } });
  }
  await recordOutcome(check.id, "refundRequested");
  return { released: false as const, message: keptMessage("refundRequested") };
}

/**
 * Runs a release plan after the reply has committed. Free places go through
 * the guest's own cancellation without revalidating (it would re-render the
 * retired /attend page as a 404); a paid single ticket through the buyer's
 * own cancellation under its refund policy (never a full refund by default;
 * an owed desk payment is cancelled); a closed policy opens a refund request
 * instead. Anything refused leaves the reply recorded with
 * `releaseOutcome = "failed"`.
 */
export async function carryOutRelease(params: { check: CheckForRelease; plan: ReleasePlan; note: string; guestName: string; now: Date; }): Promise<{ released: true; } | { released: false; message: string; }> {
  const { check, plan } = params;
  switch (plan.kind) {
    case "hold":
      return { released: false, message: keptMessage(plan.outcome) };
    case "none":
      return failed(check, plan.reason);
    case "free": {
      const result = await cancelRegistrationByToken(check.rsvp.userId, check.rsvp.checkInToken, { revalidate: false });
      return result.ok ? released(check, false) : failed(check, result.error);
    }
    case "paid": {
      try {
        await cancelOrderAsBuyer({ orderId: plan.orderId, now: params.now });
      } catch (error) {
        if (!(error instanceof PaymentOperationError)) console.error("[attendance check] paid release failed");
        return failed(check, error instanceof PaymentOperationError ? error.message : "Your order could not be cancelled automatically.");
      }
      return released(check, true);
    }
    case "refundRequest":
      return refundRequestOnce(check, plan.orderId, params.note, params.guestName, params.now);
  }
}

/**
 * A "Yes" after a "No" opened a refund request: while that request is still
 * open it is withdrawn (audited) and organisers are told the guest is coming
 * after all. A request already decided is left alone; Finance shows the
 * guest's current answer beside it.
 */
export async function withdrawRefundRequestOnYes(check: CheckForRelease, guestName: string, now: Date) {
  if (!check.refundRequestId) return;
  const requestId = check.refundRequestId;
  await prisma.$transaction(async (tx) => {
    const withdrawn = await tx.refundRequest.updateMany({
      where: { id: requestId, status: RefundRequestStatus.OPEN },
      data: { status: RefundRequestStatus.WITHDRAWN, decisionNote: "Withdrawn: the guest said they're coming after all.", decidedAt: now },
    });
    if (withdrawn.count !== 1) return;
    const request = await tx.refundRequest.findUniqueOrThrow({ where: { id: requestId }, select: { orderId: true, order: { select: { reference: true } } } });
    await recordAuditEvent({ action: "REFUND_REQUEST_WITHDRAWN", organisationId: check.event.organisationId, targetType: "RefundRequest", targetId: requestId, metadata: { orderId: request.orderId, attendance: true }, client: tx });
    const line = `${guestName} now says they're coming to ${check.event.title}, so their refund request on order ${request.order.reference} was withdrawn.`;
    await noticeEach(tx, await organiserEmails(tx, check.event.organisationId), { organisationId: check.event.organisationId, subject: noticeSubject("Coming after all", check.event.title), lines: [line] });
    await notifyChat(tx, check.event.organisationId, "claim", line);
  });
}
