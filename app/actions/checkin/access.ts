import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { auth } from "@/lib/auth";
import { parseCheckInPayload } from "@/lib/checkIn";
import { prisma } from "@/lib/db";
import { EventPermission } from "@prisma/client";
import { canAccessEvent } from "@/lib/eventAccess";
import { isActionRateLimited } from "@/lib/actionRateLimit";

export const revalidatePath = trackedRevalidation(nextRevalidatePath);

export function revalidateAfterCheckIn(
  orgSlug: string,
  rsvp: {
    eventId: string | null;
    event: { slug: string; } | null;
    eventInstanceId: string | null;
  },
) {
  if (rsvp.eventId && rsvp.event) {
    revalidatePath(`/dashboard/${orgSlug}/event/${rsvp.eventId}`);
    revalidatePath(`/dashboard/${orgSlug}/event/${rsvp.eventId}/check-in`);
    revalidatePath(`/${orgSlug}/${rsvp.event.slug}`);
  }
  if (rsvp.eventInstanceId) {
    revalidatePath(`/${orgSlug}/i/${rsvp.eventInstanceId}`);
  }
  revalidatePath(`/${orgSlug}`);
}

export async function requireOrgMemberForEvent(
  organisationSlug: string,
  eventId: string,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false as const, error: "You must be signed in." };
  }
  if (await isActionRateLimited("checkin", session.user.id)) {
    return { ok: false as const, error: "Too many check-in requests. Please try again shortly." };
  }
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false as const, error: "Organisation not found." };

  if (!(await canAccessEvent({ userId: session.user.id, organisationId: org.id, eventId, permission: EventPermission.CHECK_IN }))) {
    return { ok: false as const, error: "You do not have permission to operate check-in." };
  }

  const event = await prisma.event.findFirst({
    where: { id: eventId, organisationId: org.id },
  });
  if (!event) return { ok: false as const, error: "Event not found." };

  return {
    ok: true as const,
    event,
    orgSlug: org.slug,
    actorUserId: session.user.id,
  };
}

export function attendeeLabel(r: {
  user: { name: string | null; email: string | null; } | null;
  guestName?: string | null;
  guestEmail: string | null;
}) {
  const name = r.user?.name?.trim();
  if (name) return name;
  const gn = r.guestName?.trim();
  if (gn) return gn;
  const email = r.user?.email ?? r.guestEmail;
  return email ?? "Guest";
}

export async function resolveRsvpForToken(
  organisationSlug: string,
  eventId: string,
  rawInput: string,
) {
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false as const, error: ctx.error };

  const token = parseCheckInPayload(rawInput);
  if (!token) {
    return { ok: false as const, error: "Could not read a ticket code from that input." };
  }

  const rsvp = await prisma.rSVP.findFirst({
    where: { checkInToken: token },
    include: {
      user: { select: { name: true, email: true } },
      answers: { include: { field: { select: { key: true, label: true } } } },
      team: { select: { name: true } },
      // The attendance reply only (docs/ATTENDANCE.md); never the note or the link digest.
      attendanceCheck: { select: { response: true } },
      event: { select: { id: true, organisationId: true, slug: true } },
      eventInstance: {
        include: { series: { select: { organisationId: true } } },
      },
    },
  });

  if (!rsvp) {
    return { ok: false as const, error: "No matching ticket found." };
  }

  const orgId = ctx.event.organisationId;
  if (rsvp.eventId && rsvp.event) {
    if (rsvp.event.organisationId !== orgId || rsvp.eventId !== ctx.event.id) {
      return { ok: false as const, error: "This ticket is not for this event." };
    }
  } else if (rsvp.eventInstanceId && rsvp.eventInstance) {
    // This station is for one standalone event. A series occurrence must be
    // checked in from its own dedicated workflow, never merely by org match.
    return { ok: false as const, error: "This ticket is not for this event." };
  } else {
    return { ok: false as const, error: "Invalid registration." };
  }

  return { ok: true as const, ctx, rsvp };
}
