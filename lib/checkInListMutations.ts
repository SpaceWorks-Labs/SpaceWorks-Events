import "server-only";

import { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { CheckInGate } from "@/lib/checkIn";
import { gateListCheckIn, type CheckInListSource } from "@/lib/checkInLists";
import { unacceptedApplicant } from "@/lib/checkInMutations";

export type ListCheckInCommitResult =
  | { state: "checked-in"; checkedInAt: Date }
  | { state: "already-checked-in"; checkedInAt: Date }
  | { state: "ineligible"; gate: Extract<CheckInGate, { ok: false }> }
  | { state: "missing" };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Checks one registration into one custom list. Eligibility, the record and
 * its immutable history are one transaction: the RSVP row is locked (so a
 * status change or a parallel scan cannot slip between the check and the
 * write) and the list row is share-locked (so it cannot be archived
 * mid-scan). The `(listId, rsvpId)` unique index is the final guard.
 *
 * List check-ins never touch `RSVP.checkedInAt`, `CheckInEvent`, or the
 * realtime ticket channel; entry check-in stays exactly as it was.
 */
export async function commitListCheckIn(params: {
  listId: string;
  rsvpId: string;
  actorUserId: string | null;
  source: CheckInListSource;
  checkedInAt: Date;
  force: boolean;
}): Promise<ListCheckInCommitResult> {
  try {
    return await prisma.$transaction(async (tx): Promise<ListCheckInCommitResult> => {
      // An extra's quantity is shared by the order's guests: lock the order
      // first (the same order as refunds), then the registration.
      const owner = await tx.rSVP.findUnique({ where: { id: params.rsvpId }, select: { orderId: true } });
      if (owner?.orderId) await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${owner.orderId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${params.rsvpId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CheckInList" WHERE "id" = ${params.listId} FOR SHARE`;
      const [rsvp, list, existing] = await Promise.all([
        tx.rSVP.findUnique({ where: { id: params.rsvpId }, select: { status: true, checkedInAt: true, eventId: true, orderId: true } }),
        tx.checkInList.findUnique({ where: { id: params.listId }, select: { eventId: true, name: true, archived: true, requiresEntryCheckIn: true, addOn: { select: { id: true, name: true } } } }),
        tx.checkInListRecord.findUnique({ where: { listId_rsvpId: { listId: params.listId, rsvpId: params.rsvpId } }, select: { checkedInAt: true } }),
      ]);
      if (!rsvp || !list || rsvp.eventId !== list.eventId) return { state: "missing" };
      if (list.archived) {
        return { state: "ineligible", gate: { ok: false, reason: "This list is archived and read-only.", needsForce: false, blocked: true } };
      }
      if (existing) return { state: "already-checked-in", checkedInAt: existing.checkedInAt };
      const applicant = rsvp.status !== "CONFIRMED" && (await tx.rSVP.count({ where: { id: params.rsvpId, ...unacceptedApplicant } })) > 0;
      const gate = gateListCheckIn({ status: rsvp.status, entryCheckedInAt: rsvp.checkedInAt, force: params.force, list, applicant });
      if (!gate.ok) return { state: "ineligible", gate };
      if (list.addOn) {
        const refused = await addOnAllowance(tx, list.addOn, params.listId, rsvp.orderId);
        if (refused) return { state: "ineligible", gate: { ok: false, reason: refused, needsForce: false, blocked: true } };
      }
      await tx.checkInListRecord.create({
        data: { listId: params.listId, rsvpId: params.rsvpId, actorUserId: params.actorUserId, source: params.source, checkedInAt: params.checkedInAt },
      });
      await tx.checkInListEvent.create({
        data: { listId: params.listId, rsvpId: params.rsvpId, actorUserId: params.actorUserId, action: "CHECKED_IN", source: params.source, occurredAt: params.checkedInAt },
      });
      return { state: "checked-in", checkedInAt: params.checkedInAt };
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Defence in depth: the row lock already serialises scans of one RSVP.
    const existing = await prisma.checkInListRecord.findUnique({ where: { listId_rsvpId: { listId: params.listId, rsvpId: params.rsvpId } }, select: { checkedInAt: true } });
    if (!existing) throw error;
    return { state: "already-checked-in", checkedInAt: existing.checkedInAt };
  }
}

/**
 * A list for an extra: the guest's confirmed order must have bought it, and
 * its guests share the quantity bought. Returns why not, or null.
 */
async function addOnAllowance(tx: Prisma.TransactionClient, addOn: { id: string; name: string; }, listId: string, orderId: string | null) {
  const bought = orderId
    ? (await tx.orderLine.aggregate({ _sum: { quantity: true }, where: { addOnId: addOn.id, order: { id: orderId, status: OrderStatus.CONFIRMED } } }))._sum.quantity ?? 0
    : 0;
  if (bought === 0) return `This list is for guests who bought ${addOn.name}.`;
  const used = await tx.checkInListRecord.count({ where: { listId, rsvp: { orderId } } });
  return used >= bought ? `This order bought ${bought} ${addOn.name}, and ${bought === 1 ? "it has" : "all have"} been collected.` : null;
}

export type ListUndoCommitResult = "undone" | "not-checked-in" | "archived" | "missing";

/** Removes one list check-in and records the undo. Archived lists are read-only. */
export function commitUndoListCheckIn(params: { listId: string; rsvpId: string; actorUserId: string | null; source: CheckInListSource }): Promise<ListUndoCommitResult> {
  return prisma.$transaction(async (tx): Promise<ListUndoCommitResult> => {
    await tx.$queryRaw`SELECT "id" FROM "CheckInList" WHERE "id" = ${params.listId} FOR SHARE`;
    const list = await tx.checkInList.findUnique({ where: { id: params.listId }, select: { archived: true } });
    if (!list) return "missing";
    if (list.archived) return "archived";
    const removed = await tx.checkInListRecord.deleteMany({ where: { listId: params.listId, rsvpId: params.rsvpId } });
    if (removed.count !== 1) return "not-checked-in";
    await tx.checkInListEvent.create({
      data: { listId: params.listId, rsvpId: params.rsvpId, actorUserId: params.actorUserId, action: "CHECK_IN_UNDONE", source: params.source },
    });
    return "undone";
  });
}
