import "server-only";

import { type Prisma } from "@prisma/client";
import { recordAuditEvent } from "@/lib/audit";
import { notifyChat } from "@/lib/chat/notify";
import { noticeMany, noticeSubject, titleWith } from "@/lib/notices";
import { peopleWithPlaces } from "./eventCancellation";
import { lockSeriesDates } from "./targets";

type Cancellation = {
  organisationId: string; actorUserId: string; reason: string; now: Date;
  date: { id: string; startDateTime: Date; series: { title: string; timezone: string } };
};

/** Called only for newly marked dates, inside the same transaction. */
async function notifyOccurrenceCancelled(tx: Prisma.TransactionClient, params: Cancellation) {
  const { organisationId, actorUserId, reason, date } = params;
  const label = titleWith(date.series.title, date.startDateTime.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: date.series.timezone }));
  await recordAuditEvent({ action: "EVENT_INSTANCE_CANCELLED", actorUserId, organisationId, targetType: "EventInstance", targetId: date.id, client: tx });
  // Everyone is told before anything is removed, in this transaction, so a
  // retry can never lose the notices. A retry that finds the date already
  // cancelled has told them.
  await notifyChat(tx, organisationId, "event", `${label} was cancelled. Everyone on it is being told, and buyers refunded.`);
  return noticeMany(tx, await peopleWithPlaces(tx, { eventInstanceId: date.id }), {
    organisationId,
    subject: noticeSubject("Cancelled", label),
    lines: [
      `${label} has been cancelled by the organiser.`,
      ...(reason ? [reason] : []),
      "If you paid, your refund is on its way: card and UPI refunds can take 5 to 10 working days to appear. A pass keeps its other dates.",
    ],
  });
}

async function removeFreePlaces(tx: Prisma.TransactionClient, date: { id: string }) {
  await tx.rSVP.deleteMany({ where: { eventInstanceId: date.id, OR: [{ orderId: null }, { order: { totalMinor: BigInt(0) } }] } });
}

/** Mark and notify under the organisation, series and date locks, before refunds. */
export async function markOccurrenceCancelled(tx: Prisma.TransactionClient, params: Cancellation) {
  const { date, now } = params;
  const current = await tx.eventInstance.findUniqueOrThrow({ where: { id: date.id }, select: { cancelledAt: true } });
  let told = 0;
  if (!current.cancelledAt) {
    await tx.eventInstance.update({ where: { id: date.id }, data: { cancelledAt: now } });
    told = await notifyOccurrenceCancelled(tx, params);
  }
  // Free registrations simply go; paid ones are handled with their orders below.
  await removeFreePlaces(tx, date);
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
  await tx.eventInstance.updateMany({
    where: { eventSeriesId: params.seriesId, endDateTime: { gt: params.now }, cancelledAt: null },
    data: { cancelledAt: params.now },
  });
  for (const date of dates) {
    await notifyOccurrenceCancelled(tx, { ...params, date, reason: "The series was cancelled." });
  }
  // One deletion after the notices have captured every free recipient.
  await tx.rSVP.deleteMany({ where: {
    eventInstanceId: { in: dates.map((date) => date.id) },
    OR: [{ orderId: null }, { order: { totalMinor: BigInt(0) } }],
  } });
  return dates;
}
