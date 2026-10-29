import "server-only";

import { EventStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canCreateEvent, canPublishEvents, getMembership } from "@/lib/permissions";
import { deleteEventSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { flattenZodErrors } from "../utils";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { z } from "zod";
import { hasPaidOrders, notifyEventCancelled, PAID_EVENT_REFUSAL, refundCancelledEvent } from "@/lib/payments/eventCancellation";
import { fenceOrganisation } from "@/lib/payments/targets";
import { revalidateEventPaths, revalidatePath } from "./shared";
import { emitWebhookEvent } from "@/lib/webhooks/emit";

export async function deleteEvent(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id))
    return { ok: false, error: "Too many updates. Please try again later." };

  const parsed = deleteEventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return { ok: false, error: "You do not have permission to delete events." };
  }

  const event = await prisma.event.findFirst({
    where: { id: eventId, organisationId: org.id },
  });
  if (!event) return { ok: false, error: "Event not found." };
  // Deleting would leave people who paid without their tickets: cancel instead, which refunds them.
  if (await hasPaidOrders({ eventId: event.id })) return { ok: false, error: PAID_EVENT_REFUSAL };

  const slug = event.slug;
  try {
    const refused = await prisma.$transaction(async (tx) => {
      // The locks a reservation takes (docs/PAYMENTS.md): the organisation
      // fence, then the event. A paid order committed before this is seen
      // below; one that waits finds the event gone.
      await fenceOrganisation(tx, org.id);
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      if (await hasPaidOrders({ eventId: event.id }, tx)) return true;
      if (event.status === EventStatus.PUBLISHED && event.endDateTime > new Date()) await notifyEventCancelled(tx, { organisationId: org.id, eventId: event.id, title: event.title });
      // Claims outlive the event; their policy terms stay in each claim's snapshot
      // (the event lock is held, as when claims are filed, approved or paid).
      await tx.expenseClaim.updateMany({ where: { policy: { eventId: event.id } }, data: { policyId: null } });
      await tx.event.delete({ where: { id: event.id } });
      return false;
    });
    if (refused) return { ok: false, error: PAID_EVENT_REFUSAL };
    await recordAuditEvent({
      action: "EVENT_DELETED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: event.id,
    });
    revalidatePath(`/${org.slug}`);
    revalidatePath(`/${org.slug}/${slug}`);
    revalidatePath(`/dashboard/${org.slug}`);
    return { ok: true };
  } catch {
    console.error("[event] slug update failed");
    return { ok: false, error: "Could not delete event." };
  }
}

const cancelEventSchema = z.object({
  organisationSlug: z.string().trim().min(1).max(120),
  eventId: z.string().trim().min(1).max(128),
  reason: z.string().trim().max(500).default(""),
}).strict();

/**
 * Cancel an event: it stops taking registrations and shows as cancelled,
 * everyone who paid is refunded in full (and emailed), and everyone with a
 * free place is told. Owners and admins only. Running it again only finishes
 * what's left, so nobody is refunded twice.
 */
export async function cancelEvent(input: unknown): Promise<ActionResult<{ refunded: number; failed: number; notified: number; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many updates. Please try again later." };
  const parsed = cancelEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose an event to cancel." };
  const org = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug } });
  if (!org) return { ok: false, error: "Organisation not found." };
  if (!canPublishEvents(await getMembership(session.user.id, org.id))) return { ok: false, error: "Only owners and admins can cancel events." };
  const event = await prisma.event.findFirst({ where: { id: parsed.data.eventId, organisationId: org.id }, select: { id: true, slug: true, title: true, status: true } });
  if (!event) return { ok: false, error: "Event not found." };

  let cancelledNow = false;
  const notified = await prisma.$transaction(async (tx) => {
    await fenceOrganisation(tx, org.id);
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
    if (event.status === EventStatus.CANCELLED) return 0;
    cancelledNow = true;
    await tx.event.update({ where: { id: event.id }, data: { status: EventStatus.CANCELLED } });
    // Everyone is told here; buyers also hear about their refund.
    const told = await notifyEventCancelled(tx, { organisationId: org.id, eventId: event.id, title: event.title, reason: parsed.data.reason });
    await recordAuditEvent({ action: "EVENT_CANCELLED", actorUserId: session.user!.id, organisationId: org.id, targetType: "Event", targetId: event.id, client: tx });
    return told;
  });
  if (cancelledNow) emitWebhookEvent({ type: "event.cancelled", eventId: event.id, previousStatus: event.status });
  const result = await refundCancelledEvent({ eventId: event.id, organisationId: org.id, actorUserId: session.user.id });
  revalidateEventPaths(org.slug, event.slug, event.id);
  return { ok: true, data: { ...result, notified } };
}
