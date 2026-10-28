import "server-only";

import { AdmissionMode, AdmissionStatus, RegistrationMode } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import { emitAll } from "./notify";
import { offerCeiling, offersLeft, promotionOrder, type QueueCandidate } from "./rules";
import { applicationSelect, countOfferHolding, lockAdmissionEvent, ticketTypeOffers, type AdmissionEvent, type ApplicationRow } from "./state";
import { offerPlace, waitlistApplication } from "./transitions";
import type { Prisma } from "@prisma/client";
import { seatTakingWhere } from "@/lib/payments/holds";

/*
 * Waitlist promotion (docs/ADMISSION.md "Waitlist"): when an offer is
 * declined, withdrawn or expires, or a place frees up, the waitlist is offered
 * the free offers first in, first offered. An application that can't take a
 * place now (its ticket type is full, its team is below the minimum size) is
 * passed over with the reason recorded, and stays in the queue. The beat runs
 * this for every admission event too, as a safety net.
 */

const QUEUE_PAGE = 200;

async function fitsNow(tx: Prisma.TransactionClient, event: AdmissionEvent, app: ApplicationRow, typeRoom: Map<string, number | null>, now: Date): Promise<{ fits: boolean; reason?: string }> {
  if (app.teamId && event.teamMinSize) {
    const members = await tx.rSVP.count({ where: { teamId: app.teamId } });
    if (members < event.teamMinSize) return { fits: false, reason: `The team has fewer than ${event.teamMinSize} members.` };
  }
  const holder = app.rsvpId
    ? await tx.rSVP.findUnique({ where: { id: app.rsvpId }, select: { ticketTypeId: true } })
    : await tx.team.findUnique({ where: { id: app.teamId! }, select: { leaderRsvp: { select: { ticketTypeId: true } } } }).then((team) => team?.leaderRsvp ?? null);
  const typeId = holder?.ticketTypeId;
  if (!typeId) return { fits: true };
  if (!typeRoom.has(typeId)) {
    const type = await tx.ticketType.findUnique({ where: { id: typeId }, select: { capacity: true, seatsPerTicket: true, name: true } });
    if (!type || type.capacity == null) typeRoom.set(typeId, null);
    else {
      const taken = Math.ceil((await tx.rSVP.count({ where: { ticketTypeId: typeId, eventId: event.id, ...seatTakingWhere(now) } })) / type.seatsPerTicket);
      typeRoom.set(typeId, type.capacity - taken - (await ticketTypeOffers(tx, typeId, event.id)));
    }
  }
  const room = typeRoom.get(typeId);
  if (room == null) return { fits: true };
  if (room <= 0) return { fits: false, reason: "Its ticket type is full." };
  typeRoom.set(typeId, room - 1);
  return { fits: true };
}

/** Offer free places to the waitlist, in queue order. Returns how many were offered. */
export async function promoteWaitlisted(eventId: string, now = new Date()): Promise<number> {
  const webhooks: WebhookEmission[] = [];
  const offered = await prisma.$transaction(async (tx) => {
    const event = await lockAdmissionEvent(tx, eventId);
    if (!event?.admissionEnabled || event.endDateTime <= now) return 0;
    const left = offersLeft(offerCeiling(event), await countOfferHolding(tx, event.id));
    if (left === 0) return 0;
    const queue = await tx.admissionApplication.findMany({ where: { eventId, status: AdmissionStatus.WAITLISTED }, orderBy: [{ queuedAt: "asc" }, { id: "asc" }], take: QUEUE_PAGE, select: applicationSelect });
    if (queue.length === 0) return 0;
    const typeRoom = new Map<string, number | null>();
    const candidates: QueueCandidate[] = [];
    for (const app of queue) {
      if (left != null && candidates.filter((candidate) => candidate.fits).length >= left) break;
      candidates.push({ id: app.id, queuedAt: app.queuedAt ?? app.submittedAt, ...(await fitsNow(tx, event, app, typeRoom, now)) });
    }
    const plan = promotionOrder(candidates, left);
    for (const skipped of plan.skipped) {
      await tx.admissionApplication.updateMany({ where: { id: skipped.id, status: AdmissionStatus.WAITLISTED }, data: { skipReason: skipped.reason.slice(0, 200) } });
    }
    const byId = new Map(queue.map((app) => [app.id, app]));
    for (const id of plan.offer) webhooks.push(...(await offerPlace({ tx, event, app: byId.get(id)!, now })));
    return plan.offer.length;
  }, { timeout: 30_000, maxWait: 10_000 });
  emitAll(webhooks);
  return offered;
}

/**
 * AUTO mode: every application in review is offered a place as it arrives,
 * in arrival order, while offers are left; the rest are waitlisted.
 */
export async function autoDecide(eventId: string, now = new Date()): Promise<number> {
  const webhooks: WebhookEmission[] = [];
  const decided = await prisma.$transaction(async (tx) => {
    const event = await lockAdmissionEvent(tx, eventId);
    if (!event?.admissionEnabled || event.admissionMode !== AdmissionMode.AUTO || event.endDateTime <= now) return 0;
    let left = offersLeft(offerCeiling(event), await countOfferHolding(tx, event.id));
    const pending = await tx.admissionApplication.findMany({ where: { eventId, status: AdmissionStatus.IN_REVIEW }, orderBy: [{ submittedAt: "asc" }, { id: "asc" }], take: QUEUE_PAGE, select: applicationSelect });
    for (const app of pending) {
      // A team below the minimum size waits in review until it is complete.
      if (app.teamId && event.registrationMode === RegistrationMode.TEAM && event.teamMinSize && (await tx.rSVP.count({ where: { teamId: app.teamId } })) < event.teamMinSize) continue;
      if (left == null || left > 0) {
        webhooks.push(...(await offerPlace({ tx, event, app, now })));
        if (left != null) left -= 1;
      } else webhooks.push(...(await waitlistApplication({ tx, event, app, now })));
    }
    return pending.length;
  }, { timeout: 30_000, maxWait: 10_000 });
  emitAll(webhooks);
  return decided;
}
