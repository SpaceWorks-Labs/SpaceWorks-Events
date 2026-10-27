import { gateCheckInForStatus } from "@/lib/checkIn";
import { prisma } from "@/lib/db";
import { checkInByRsvpIdSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { flattenZodErrors } from "../utils";
import { commitCheckInProjection } from "@/lib/checkInMutations";
import { crewDoorSelect, doorExtras, getCheckInDetails, getRegistrationDetails } from "@/lib/checkInDetails";
import { attendeeLabel, requireOrgMemberForEvent, revalidateAfterCheckIn } from "./access";
import type { CheckInPreviewData, CheckInResultData } from "../checkin";

/**
 * Loads the same door details used by QR preview before a staff member confirms
 * a check-in selected from attendee search.
 */
export async function previewCheckInByRsvpId(
  input: unknown,
): Promise<ActionResult<CheckInPreviewData>> {
  const parsed = checkInByRsvpIdSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, rsvpId, force } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvp = await prisma.rSVP.findFirst({
    where: { id: rsvpId, eventId: ctx.event.id },
    include: {
      user: { select: { name: true, email: true } },
      answers: { include: { field: { select: { key: true, label: true } } } },
      team: { select: { name: true } }, crewMember: crewDoorSelect,
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };

  return {
    ok: true,
    data: {
      rsvpId: rsvp.id,
      displayName: attendeeLabel(rsvp),
      email: rsvp.user?.email ?? rsvp.guestEmail,
      status: rsvp.status,
      alreadyCheckedIn: Boolean(rsvp.checkedInAt),
      checkedInAt: rsvp.checkedInAt?.toISOString() ?? null,
      checkInQrToken: rsvp.checkInToken,
      checkInDetails: getCheckInDetails(rsvp.answers, rsvp.crewMember),
      registrationDetails: getRegistrationDetails(rsvp.answers),
      ...doorExtras(rsvp),
      gate: gateCheckInForStatus(rsvp.status, Boolean(force)),
    },
  };
}

export async function checkInByRsvpId(
  input: unknown,
): Promise<ActionResult<CheckInResultData>> {
  const parsed = checkInByRsvpIdSchema.safeParse(input);

  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, rsvpId, force } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvp = await prisma.rSVP.findFirst({
    where: { id: rsvpId, eventId: ctx.event.id },
    include: {
      user: { select: { name: true, email: true } },
      answers: { include: { field: { select: { key: true, label: true } } } },
      team: { select: { name: true } }, crewMember: crewDoorSelect,
      event: { select: { slug: true } },
      eventInstance: { select: { id: true } },
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };

  const gate = gateCheckInForStatus(rsvp.status, Boolean(force));
  if (!gate.ok) {
    if (gate.blocked) {
      return { ok: false, error: gate.reason };
    }
    return {
      ok: false,
      error: gate.reason,
      needsForce: true,
    };
  }

  if (rsvp.checkedInAt) {
    return {
      ok: true,
      data: {
        rsvpId: rsvp.id,
        displayName: attendeeLabel(rsvp),
        email: rsvp.user?.email ?? rsvp.guestEmail,
        status: rsvp.status,
        alreadyCheckedIn: true,
        checkedInAt: rsvp.checkedInAt.toISOString(),
        checkInQrToken: rsvp.checkInToken,
        checkInDetails: getCheckInDetails(rsvp.answers, rsvp.crewMember),
        registrationDetails: getRegistrationDetails(rsvp.answers),
        ...doorExtras(rsvp),
      },
    };
  }

  const now = new Date();
  const committed = await commitCheckInProjection({
    rsvpId: rsvp.id,
    actorUserId: ctx.actorUserId,
    source: "online",
    checkedInAt: now,
    force: Boolean(force),
  });
  if (committed.state !== "checked-in") {
    if (committed.state === "missing") return { ok: false, error: "RSVP not found." };
    if (committed.state === "ineligible") {
      const currentGate = gateCheckInForStatus(committed.status, Boolean(force));
      return { ok: false, error: currentGate.ok ? "Check-in could not be completed." : currentGate.reason };
    }
    return {
      ok: true,
      data: {
        rsvpId: rsvp.id,
        displayName: attendeeLabel(rsvp),
        email: rsvp.user?.email ?? rsvp.guestEmail,
        status: rsvp.status,
        alreadyCheckedIn: true,
        checkedInAt: committed.checkedInAt.toISOString(),
        checkInQrToken: rsvp.checkInToken,
        checkInDetails: getCheckInDetails(rsvp.answers, rsvp.crewMember),
        registrationDetails: getRegistrationDetails(rsvp.answers),
        ...doorExtras(rsvp),
      },
    };
  }

  revalidateAfterCheckIn(ctx.orgSlug, {
    eventId: rsvp.eventId,
    event: rsvp.event,
    eventInstanceId: rsvp.eventInstanceId,
  });

  return {
    ok: true,
    data: {
      rsvpId: rsvp.id,
      displayName: attendeeLabel(rsvp),
      email: rsvp.user?.email ?? rsvp.guestEmail,
      status: rsvp.status,
      alreadyCheckedIn: false,
      checkedInAt: now.toISOString(),
      checkInQrToken: rsvp.checkInToken,
      checkInDetails: getCheckInDetails(rsvp.answers, rsvp.crewMember),
      registrationDetails: getRegistrationDetails(rsvp.answers),
      ...doorExtras(rsvp),
    },
  };
}
