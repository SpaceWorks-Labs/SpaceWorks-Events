import "server-only";

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueueOperatorNotice } from "@/lib/outbox/enqueue";
import { rsvpWebhookSnapshot, rsvpWebhookSnapshotSelect } from "@/lib/teamUnits";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";
import { fail, lockEventForCrew, type CrewResult, type OrganiserCrewContext } from "./shared";

/** Event -> RSVP -> crew for editing and removal, because removal cascades from RSVP. */
export async function lockCrewRows(tx: Prisma.TransactionClient, eventId: string, memberId: string) {
  const found = await tx.eventCrewMember.findFirst({ where: { id: memberId, eventId }, select: { rsvpId: true } });
  if (!found) return false;
  await tx.$queryRaw`SELECT "id" FROM "RSVP" WHERE "id" = ${found.rsvpId} FOR UPDATE`;
  const locked = await tx.$queryRaw<unknown[]>`SELECT "id" FROM "EventCrewMember" WHERE "id" = ${memberId} AND "eventId" = ${eventId} FOR UPDATE`;
  return locked.length === 1;
}

/** Caller owns the transaction. Its returned webhook must be emitted only after commit. */
export async function removeCrewMemberLocked(tx: Prisma.TransactionClient, ctx: OrganiserCrewContext, memberId: string): Promise<CrewResult<{ name: string; webhook: WebhookEmission }>> {
  if (!(await lockEventForCrew(tx, ctx.eventId)) || !(await lockCrewRows(tx, ctx.eventId, memberId))) return fail("Crew member not found.");
  const member = await tx.eventCrewMember.findFirst({
    where: { id: memberId, eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    select: { name: true, email: true, event: { select: { title: true } }, rsvp: { select: rsvpWebhookSnapshotSelect } },
  });
  if (!member) return fail("Crew member not found.");
  // Free crew tickets have no order. Deleting RSVP cascades to crew and clears the mentor's ownership link.
  const deleted = await tx.rSVP.deleteMany({ where: { id: member.rsvp.id, eventId: ctx.eventId, isCrew: true, orderId: null } });
  if (deleted.count !== 1) return fail("Crew member not found.");
  if (member.rsvp.userId) {
    await enqueueOperatorNotice(tx, {
      to: member.email, organisationId: ctx.organisationId,
      subject: `You're no longer on the crew for ${member.event.title.slice(0, 150)}`,
      lines: [`The organisers removed you from the crew for ${member.event.title}, so your crew ticket no longer works.`, "If you still want to attend, register again on the event page, or contact the organisers."],
    });
  }
  return { ok: true, data: { name: member.name, webhook: {
    type: "registration.status_changed", rsvpId: member.rsvp.id, status: "CANCELLED",
    previousStatus: RsvpStatus.CONFIRMED, snapshot: rsvpWebhookSnapshot(member.rsvp),
  } } };
}

/** Remove the free ticket, check-in and crew place together, then notify webhook receivers. */
export async function removeCrewMember(ctx: OrganiserCrewContext, memberId: string): Promise<CrewResult<{ name: string }>> {
  const result = await prisma.$transaction((tx) => removeCrewMemberLocked(tx, ctx, memberId));
  if (!result.ok) return result;
  emitWebhookEvent(result.data.webhook);
  return { ok: true, data: { name: result.data.name } };
}
