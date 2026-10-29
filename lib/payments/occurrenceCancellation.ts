import "server-only";

import { type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeEach, noticeSubject, titleWith } from "@/lib/notices";
import { peopleWithPlaces } from "./eventCancellation";
import { lockSeriesDates } from "./targets";

/** Mark and notify under the organisation, series and date locks, before refunds. */
export async function markOccurrenceCancelled(tx: Prisma.TransactionClient, params: {
  organisationId: string; actorUserId: string; reason: string; now: Date;
  date: { id: string; startDateTime: Date; series: { title: string; timezone: string } };
}) {
  const { organisationId, actorUserId, reason, now, date } = params;
  const label = titleWith(date.series.title, date.startDateTime.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: date.series.timezone }));
  const current = await tx.eventInstance.findUniqueOrThrow({ where: { id: date.id }, select: { cancelledAt: true } });
  if (!current.cancelledAt) {
    await tx.eventInstance.update({ where: { id: date.id }, data: { cancelledAt: now } });
    await recordAuditEvent({ action: "EVENT_INSTANCE_CANCELLED", actorUserId, organisationId, targetType: "EventInstance", targetId: date.id, client: tx });
  }
  // Everyone is told before anything is removed, in this transaction, so a
  // retry can never lose the notices. A retry that finds the date already
  // cancelled has told them.
  if (!current.cancelledAt) await notifyChat(tx, organisationId, "event", `${label} was cancelled. Everyone on it is being told, and buyers refunded.`);
  const told = current.cancelledAt ? 0 : await noticeEach(tx, await peopleWithPlaces(tx, { eventInstanceId: date.id }), {
    organisationId,
    subject: noticeSubject("Cancelled", label),
    lines: [
      `${label} has been cancelled by the organiser.`,
      ...(reason ? [reason] : []),
      "If you paid, your refund is on its way: card and UPI refunds can take 5 to 10 working days to appear. A pass keeps its other dates.",
    ],
  });
  // Free registrations simply go; paid ones are handled with their orders below.
  await tx.rSVP.deleteMany({ where: { eventInstanceId: date.id, OR: [{ orderId: null }, { order: { totalMinor: BigInt(0) } }] } });
  return told;
}

/** Caller holds the organisation fence and series lock. Dates commit with status. */
export async function cancelUpcomingOccurrences(tx: Prisma.TransactionClient, params: {
  organisationId: string; seriesId: string; actorUserId: string; now: Date;
}) {
  await lockSeriesDates(tx, params.seriesId, null, params.now);
  const dates = await tx.eventInstance.findMany({
    where: { eventSeriesId: params.seriesId, endDateTime: { gt: params.now }, cancelledAt: null },
    select: { id: true, startDateTime: true, series: { select: { title: true, timezone: true } } },
    orderBy: { id: "asc" },
  });
  for (const date of dates) await markOccurrenceCancelled(tx, { ...params, date, reason: "The series was cancelled." });
  return dates;
}
