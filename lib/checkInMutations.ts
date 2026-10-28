import "server-only";

import { AdmissionStatus, type Prisma, type RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { publishTicketCheckedIn } from "@/lib/ticketCheckInEvents";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { currentMobileActor } from "@/lib/requestActor";

/** A mobile app's dashboard-style check-in records how the app reached it. */
function recordedSource<T extends CheckInSource>(source: T): T | "mobile-scan" | "mobile-manual" {
  const actor = currentMobileActor();
  return source === "online" && actor?.checkInSource ? actor.checkInSource : source;
}

export type CheckInSource = "online" | "offline-sync" | "venue-station" | "mobile-scan" | "mobile-manual";

export type CheckInCommitResult =
  | { state: "checked-in"; checkedInAt: Date }
  | { state: "already-checked-in"; checkedInAt: Date }
  | { state: "ineligible"; status: RsvpStatus; applicant: boolean }
  | { state: "missing" };

/**
 * Atomically combines current eligibility, the RSVP projection, and immutable
 * history. A status transition or cancellation racing the scan cannot be
 * admitted using a stale preview.
 *
 * Every path that sets `RSVP.checkedInAt` (online scan/manual, offline sync,
 * venue station) goes through here, so the realtime ticket notification is
 * published once, only for a real transition, and only after the transaction
 * has committed.
 *
 * An override (`force`) never admits an admission application that isn't
 * ACCEPTED (its own, or its team's): such a registration has no place
 * (docs/ADMISSION.md), so it is `ineligible` with `applicant`.
 */
const notAccepted = { status: { not: AdmissionStatus.ACCEPTED } } satisfies Prisma.AdmissionApplicationWhereInput;
/** A registration whose own (solo) or team's admission application isn't ACCEPTED. */
export const unacceptedApplicant = { OR: [{ admissionApplication: { is: notAccepted } }, { team: { is: { admissionApplication: { is: notAccepted } } } }] } satisfies Prisma.RSVPWhereInput;

export async function commitCheckInProjection(params: {
  rsvpId: string;
  actorUserId: string | null;
  source: CheckInSource;
  checkedInAt: Date;
  force: boolean;
}): Promise<CheckInCommitResult> {
  const result = await prisma.$transaction(async (tx): Promise<CheckInCommitResult> => {
    const allowedStatuses = params.force
      ? ["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL"] as const
      : ["CONFIRMED"] as const;
    const updated = await tx.rSVP.updateMany({
      where: { id: params.rsvpId, checkedInAt: null, status: { in: [...allowedStatuses] }, ...(params.force ? { NOT: unacceptedApplicant } : {}) },
      data: { checkedInAt: params.checkedInAt },
    });
    if (updated.count === 1) {
      await tx.checkInEvent.create({
        data: {
          rsvpId: params.rsvpId,
          actorUserId: params.actorUserId,
          action: "CHECKED_IN",
          source: recordedSource(params.source),
          occurredAt: params.checkedInAt,
        },
      });
      return { state: "checked-in", checkedInAt: params.checkedInAt };
    }
    const current = await tx.rSVP.findUnique({ where: { id: params.rsvpId }, select: { checkedInAt: true, status: true } });
    if (!current) return { state: "missing" };
    if (current.checkedInAt) return { state: "already-checked-in", checkedInAt: current.checkedInAt };
    const applicant = current.status !== "CONFIRMED" && (await tx.rSVP.count({ where: { id: params.rsvpId, ...unacceptedApplicant } })) > 0;
    return { state: "ineligible", status: current.status, applicant };
  });
  if (result.state === "checked-in") {
    publishTicketCheckedIn({ rsvpId: params.rsvpId, checkedInAt: result.checkedInAt });
    emitWebhookEvent({ type: "checkin.created", rsvpId: params.rsvpId, checkedInAt: result.checkedInAt });
  }
  return result;
}

export async function commitUndoCheckInProjection(params: {
  rsvpId: string;
  actorUserId: string | null;
  source: "online" | "venue-station" | "mobile-scan" | "mobile-manual";
}) {
  const undone = await prisma.$transaction(async (tx) => {
    const changed = await tx.rSVP.updateMany({
      where: { id: params.rsvpId, checkedInAt: { not: null } },
      data: { checkedInAt: null },
    });
    if (changed.count !== 1) return false;
    await tx.checkInEvent.create({
      data: {
        rsvpId: params.rsvpId,
        actorUserId: params.actorUserId,
        action: "CHECK_IN_UNDONE",
        source: recordedSource(params.source),
      },
    });
    return true;
  });
  if (undone) emitWebhookEvent({ type: "checkin.undone", rsvpId: params.rsvpId, undoneAt: new Date() });
  return undone;
}
