import { revalidatePath as nextRevalidatePath } from "next/cache";
import { CREW_REGISTRATION_ERROR } from "@/lib/core/crew/shared";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { PaymentOperationError } from "@/lib/payments/operations";
import type { ActionResult } from "../org";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

export function revalidateRsvpPaths(params: {
  orgSlug: string;
  eventSlug?: string;
  eventId?: string;
  eventInstanceId?: string;
}) {
  const { orgSlug, eventSlug, eventId, eventInstanceId } = params;
  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/dashboard/${orgSlug}`);
  if (eventSlug && eventId) {
    revalidatePath(`/${orgSlug}/${eventSlug}`);
    revalidatePath(`/dashboard/${orgSlug}/event/${eventId}`);
  }
  if (eventInstanceId) {
    revalidatePath(`/${orgSlug}/i/${eventInstanceId}`);
  }
}

export async function loadRsvpContext(
  organisationSlug: string,
  userId: string,
  rsvpId: string,
  eventId: string | undefined,
  eventInstanceId: string | undefined,
) {
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { error: "Organisation not found." as const };

  // Organisation OWNER/ADMIN, or the exact MANAGE_REGISTRATIONS grant on the event or series.
  if (!(await canManageRegistrationsFor({ userId, organisationId: org.id, eventId, eventInstanceId }))) {
    return { error: "You do not have permission to manage attendees." as const };
  }

  if (eventId) {
    const event = await prisma.event.findFirst({
      where: { id: eventId, organisationId: org.id },
    });
    if (!event) return { error: "Event not found." as const };
    const rsvp = await prisma.rSVP.findFirst({
      where: { id: rsvpId, eventId: event.id },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!rsvp) return { error: "RSVP not found." as const };
    // Crew tickets are confirmed by the crew list, never approved, declined or promoted here (docs/CREW.md).
    if (rsvp.isCrew) return { error: CREW_REGISTRATION_ERROR } as const;
    return { org, event, rsvp, instance: null as null };
  }

  if (eventInstanceId) {
    const instance = await prisma.eventInstance.findFirst({
      where: {
        id: eventInstanceId,
        series: { organisationId: org.id },
      },
      include: { series: true },
    });
    if (!instance) return { error: "Instance not found." as const };
    const rsvp = await prisma.rSVP.findFirst({
      where: { id: rsvpId, eventInstanceId: instance.id },
      include: { user: { select: { email: true, name: true } } },
    });
    if (!rsvp) return { error: "RSVP not found." as const };
    return { org, event: null, instance, rsvp };
  }

  return { error: "Event not found." as const };
}

/** A paid order waiting for approval or a waitlist place; it moves as a whole. */
export async function paidRequest(rsvp: { orderId: string | null; }) {
  if (!rsvp.orderId) return null;
  const order = await prisma.order.findUnique({ where: { id: rsvp.orderId }, select: { id: true, status: true, totalMinor: true } });
  return order && order.status === "REQUESTED" && order.totalMinor > BigInt(0) ? order : null;
}

/** Run a paid-order operation, turning its refusal into the action's error. */
export async function paymentOperation(run: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message };
    throw error;
  }
}

export function attendeeEmail(rsvp: {
  guestEmail: string | null;
  user: { email: string | null; } | null;
}): string | null {
  return rsvp.user?.email?.trim() || rsvp.guestEmail;
}

export function attendeeName(rsvp: {
  guestName: string | null;
  user: { name: string | null; } | null;
}): string | undefined {
  return rsvp.user?.name?.trim() || rsvp.guestName?.trim() || undefined;
}
