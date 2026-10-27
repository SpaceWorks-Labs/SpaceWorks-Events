import "server-only";

import type { Prisma } from "@prisma/client";
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

/**
 * A "No" on a paid ticket that is not released automatically (several
 * tickets on the order, or bought by someone else): owners and admins are
 * emailed and the organisation's chat hears it as a cancellation. Inside the
 * reply's transaction, so the notice exists exactly when the reply does.
 * Counts and names only; never the guest's note or any link.
 */
export async function notifyOrganisersOfKeptPlace(tx: Prisma.TransactionClient, params: {
  organisationId: string; eventId: string; eventTitle: string; rsvpId: string; guestName: string; outcome: "multiTicket" | "notBuyer";
}) {
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

type CheckForRelease = {
  id: string; rsvpId: string; eventId: string;
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
 * Runs a release plan after the reply has committed. Free places go through
 * the guest's own cancellation without revalidating (it would re-render the
 * retired /attend page as a 404); a paid single ticket through the buyer's
 * own cancellation under its refund policy (never a full refund by default);
 * a closed policy opens a refund request instead. Anything refused leaves
 * the reply recorded with `releaseOutcome = "failed"`.
 */
export async function carryOutRelease(params: { check: CheckForRelease; plan: ReleasePlan; note: string; now: Date; }): Promise<{ released: true; } | { released: false; message: string; }> {
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
    case "refundRequest": {
      const reason = `Answered No to attendance confirmation for ${check.event.title}${params.note ? `: ${params.note}` : "."}`.slice(0, 1000);
      const result = await requestRefundForOrder(plan.orderId, reason);
      // An open request on the order already reaches the organisers.
      if (!result.ok && result.error !== ALREADY_REQUESTED) return failed(check, result.error);
      await recordOutcome(check.id, "refundRequested");
      return { released: false, message: keptMessage("refundRequested") };
    }
  }
}
