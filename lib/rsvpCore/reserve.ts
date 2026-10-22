import { EventPrivacyType, EventStatus, Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { noticeOrganisersOfRequest } from "@/lib/notices";
import { notifyChatAbout } from "@/lib/chat/notify";
import { isRegistrationClosed } from "@/lib/registrationCutoff";
import { seatTakingWhere } from "@/lib/payments/holds";
import { lockSeriesDates } from "@/lib/payments/targets";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { RsvpTargetClosedError } from "./shared";

export function decideRsvpStatus(params: {
  capacity: number | null;
  confirmedCount: number;
  privacyType: EventPrivacyType;
}): RsvpStatus {
  const { capacity, confirmedCount, privacyType } = params;
  const full = capacity != null && confirmedCount >= capacity;

  if (privacyType === EventPrivacyType.APPROVAL_REQUIRED) {
    return RsvpStatus.PENDING_APPROVAL;
  }
  if (full) {
    return RsvpStatus.WAITLISTED;
  }
  return RsvpStatus.CONFIRMED;
}

export type RsvpTarget = { eventId: string } | { eventInstanceId: string };

/**
 * Locks the event/occurrence row before counting confirmed attendees. This
 * serializes admissions for a capacity while retaining a database constraint
 * as the final duplicate-registration guard.
 */
export async function reserveRsvp(params: {
  target: RsvpTarget;
  capacity: number | null;
  privacyType: EventPrivacyType;
  data: Omit<Prisma.RSVPUncheckedCreateInput, "status">;
  notification: { to: string; eventTitle: string };
  afterCreate?: (tx: Prisma.TransactionClient, rsvpId: string) => Promise<void>;
  enforceOpen?: boolean;
}) {
  const reservation = await prisma.$transaction(async (tx) => {
    let capacity = params.capacity;
    let privacyType = params.privacyType;
    if ("eventId" in params.target) {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${params.target.eventId} FOR UPDATE`;
      const current = await tx.event.findUnique({
        where: { id: params.target.eventId },
        select: { capacity: true, privacyType: true, status: true, endDateTime: true, registrationClosesAt: true, registrationLeadMinutes: true, startDateTime: true, page: { select: { isPublished: true } } },
      });
      if (!current) throw new RsvpTargetClosedError();
      if (params.enforceOpen !== false && (current.status !== EventStatus.PUBLISHED || current.page?.isPublished !== true || current.endDateTime <= new Date() || isRegistrationClosed(current))) throw new RsvpTargetClosedError();
      capacity = current.capacity;
      privacyType = current.privacyType;
    } else {
      // The series row, then the date: the same order every series path locks in.
      const date = await tx.eventInstance.findUnique({ where: { id: params.target.eventInstanceId }, select: { eventSeriesId: true } });
      if (!date) throw new RsvpTargetClosedError();
      await lockSeriesDates(tx, date.eventSeriesId, [params.target.eventInstanceId], new Date());
      const current = await tx.eventInstance.findUnique({ where: { id: params.target.eventInstanceId }, select: { endDateTime: true, capacity: true, cancelledAt: true, series: { select: { capacity: true, privacyType: true, status: true } } } });
      if (!current) throw new RsvpTargetClosedError();
      if (params.enforceOpen !== false && (current.series.status !== EventStatus.PUBLISHED || current.endDateTime <= new Date() || current.cancelledAt)) throw new RsvpTargetClosedError();
      capacity = current.capacity ?? current.series.capacity;
      privacyType = current.series.privacyType;
    }

    // Paid tickets still being paid for hold their seats too.
    const confirmedCount = await tx.rSVP.count({
      where: {
        ...params.target,
        ...seatTakingWhere(new Date()),
      },
    });
    const status = decideRsvpStatus({
      capacity,
      confirmedCount,
      privacyType,
    });
    const rsvp = await tx.rSVP.create({
      data: { ...params.data, status },
      select: { id: true, checkInToken: true },
    });
    await enqueueRsvpConfirmation(tx, {
      to: params.notification.to,
      eventTitle: params.notification.eventTitle,
      status,
      checkInToken: rsvp.checkInToken,
    });
    if (status === RsvpStatus.PENDING_APPROVAL) await noticeOrganisersOfRequest(tx, params.target);
    else {
      const who = (typeof params.data.guestName === "string" && params.data.guestName.trim()) || "Someone";
      await notifyChatAbout(tx, params.target, "registration", (title) => `${who} registered for ${title}${status === RsvpStatus.WAITLISTED ? " (waitlist)" : ""}.`);
    }
    await params.afterCreate?.(tx, rsvp.id);
    const count = await tx.rSVP.count({ where: params.target });
    return { ...rsvp, status, count };
  });
  emitWebhookEvent({ type: "registration.created", rsvpId: reservation.id });
  return reservation;
}
