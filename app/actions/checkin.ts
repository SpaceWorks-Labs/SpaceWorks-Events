"use server";

import { gateCheckInForStatus } from "@/lib/checkIn";
import { prisma } from "@/lib/db";
import {
  attendeeLookupSchema,
  checkInByTokenSchema,
  undoCheckInSchema,
} from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { commitCheckInProjection, commitUndoCheckInProjection } from "@/lib/checkInMutations";
import {
  getCheckInDetails,
  getRegistrationDetails,
  type CheckInDetail,
  type RegistrationDetail,
} from "@/lib/checkInDetails";
import { attendeeLabel, requireOrgMemberForEvent, resolveRsvpForToken, revalidateAfterCheckIn } from "./checkin/access";
import {
  checkInByRsvpId as checkInByRsvpIdAction,
  previewCheckInByRsvpId as previewCheckInByRsvpIdAction,
} from "./checkin/byRsvpId";
import {
  downloadOfflineCheckInRoster as downloadOfflineCheckInRosterAction,
  syncOfflineCheckIns as syncOfflineCheckInsAction,
} from "./checkin/offline";
import { loadRecentCheckIns as loadRecentCheckInsAction } from "./checkin/recent";
import type { RecentCheckInsPage } from "@/lib/checkInRecent";

export type CheckInResultData = {
  rsvpId: string;
  displayName: string;
  email: string | null;
  status: string;
  alreadyCheckedIn: boolean;
  checkedInAt: string | null;
  /** Bearer QR token for the active, authorised print flow. Never persist or audit it. */
  checkInQrToken: string;
  checkInDetails: CheckInDetail[];
  registrationDetails: RegistrationDetail[];
  /** TEAM events: the attendee's team name, shown at the desk and on badges. Not part of any API DTO. */
  teamName?: string | null;
};

export type CheckInPreviewData = CheckInResultData & {
  gate: { ok: true; } | { ok: false; reason: string; needsForce: boolean; blocked?: boolean; };
};

export async function previewCheckInByToken(
  input: unknown,
): Promise<ActionResult<CheckInPreviewData>> {
  const parsed = checkInByTokenSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, rawInput, force } = parsed.data;
  const resolved = await resolveRsvpForToken(organisationSlug, eventId, rawInput);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const { rsvp } = resolved;
  const gate = gateCheckInForStatus(rsvp.status, Boolean(force));

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
      checkInDetails: getCheckInDetails(rsvp.answers),
      registrationDetails: getRegistrationDetails(rsvp.answers),
      teamName: rsvp.team?.name ?? null,
      gate,
    },
  };
}

export async function checkInByToken(
  input: unknown,
): Promise<ActionResult<CheckInResultData>> {
  const parsed = checkInByTokenSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, rawInput, force } = parsed.data;
  const resolved = await resolveRsvpForToken(organisationSlug, eventId, rawInput);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const { ctx, rsvp } = resolved;

  const gate = gateCheckInForStatus(rsvp.status, Boolean(force));
  if (!gate.ok) {
    if (gate.blocked) {
      return {
        ok: false,
        error: gate.reason,
      };
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
        checkInDetails: getCheckInDetails(rsvp.answers),
        registrationDetails: getRegistrationDetails(rsvp.answers),
        teamName: rsvp.team?.name ?? null,
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
        checkInDetails: getCheckInDetails(rsvp.answers),
        registrationDetails: getRegistrationDetails(rsvp.answers),
        teamName: rsvp.team?.name ?? null,
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
      checkInDetails: getCheckInDetails(rsvp.answers),
      registrationDetails: getRegistrationDetails(rsvp.answers),
      teamName: rsvp.team?.name ?? null,
    },
  };
}

export async function undoCheckIn(input: unknown): Promise<ActionResult> {
  const parsed = undoCheckInSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, rsvpId } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvp = await prisma.rSVP.findFirst({
    where: { id: rsvpId },
    include: {
      event: { select: { slug: true, organisationId: true } },
      eventInstance: {
        include: { series: { select: { organisationId: true } } },
      },
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };

  const orgId = ctx.event.organisationId;
  if (rsvp.eventId) {
    if (rsvp.eventId !== ctx.event.id || rsvp.event?.organisationId !== orgId) {
      return { ok: false, error: "RSVP not found." };
    }
  } else if (rsvp.eventInstanceId) {
    return { ok: false, error: "RSVP not found." };
  } else {
    return { ok: false, error: "RSVP not found." };
  }

  const undone = await commitUndoCheckInProjection({ rsvpId: rsvp.id, actorUserId: ctx.actorUserId, source: "online" });
  if (!undone) return { ok: false, error: "This attendee is not currently checked in." };

  revalidateAfterCheckIn(ctx.orgSlug, {
    eventId: rsvp.eventId,
    event: rsvp.event ? { slug: rsvp.event.slug } : null,
    eventInstanceId: rsvp.eventInstanceId,
  });
  return { ok: true };
}

export type LookupRow = {
  rsvpId: string;
  displayName: string;
  email: string | null;
  status: string;
  checkedInAt: string | null;
  /** TEAM events: the attendee's team name. */
  teamName?: string | null;
};

export type OfflineCheckInRosterRow = LookupRow & {
  ticketToken: string;
  checkInDetails: CheckInDetail[];
  registrationDetails: RegistrationDetail[];
};

export async function downloadOfflineCheckInRoster(
  input: unknown,
): Promise<ActionResult<{ generatedAt: string; rows: OfflineCheckInRosterRow[]; }>> {
  return downloadOfflineCheckInRosterAction(input);
}

export async function syncOfflineCheckIns(
  input: unknown,
): Promise<ActionResult<{ syncedIds: string[]; alreadyCheckedInIds: string[]; failed: { rsvpId: string; error: string; }[]; }>> {
  return syncOfflineCheckInsAction(input);
}

export async function lookupAttendeesForCheckIn(
  input: unknown,
): Promise<ActionResult<{ rows: LookupRow[]; }>> {
  const parsed = attendeeLookupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, query } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const q = query.trim().toLowerCase();
  if (q.length < 2) {
    return { ok: true, data: { rows: [] } };
  }

  const rsvps = await prisma.rSVP.findMany({
    where: {
      eventId: ctx.event.id,
      OR: [
        { guestEmail: { contains: q, mode: "insensitive" } },
        { guestName: { contains: q, mode: "insensitive" } },
        { user: { email: { contains: q, mode: "insensitive" } } },
        { user: { name: { contains: q, mode: "insensitive" } } },
        // TEAM events: typing a team name lists its members. The team is
        // matched inside this event only.
        { team: { eventId: ctx.event.id, name: { contains: q, mode: "insensitive" } } },
      ],
    },
    take: 12,
    include: { user: { select: { name: true, email: true } }, team: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });

  const rows: LookupRow[] = rsvps.map((r) => ({
    rsvpId: r.id,
    displayName: attendeeLabel(r),
    email: r.user?.email ?? r.guestEmail,
    status: r.status,
    checkedInAt: r.checkedInAt?.toISOString() ?? null,
    teamName: r.team?.name ?? null,
  }));

  return { ok: true, data: { rows } };
}

/**
 * Loads the same door details used by QR preview before a staff member confirms
 * a check-in selected from attendee search.
 */
export async function previewCheckInByRsvpId(
  input: unknown,
): Promise<ActionResult<CheckInPreviewData>> {
  return previewCheckInByRsvpIdAction(input);
}

export async function checkInByRsvpId(
  input: unknown,
): Promise<ActionResult<CheckInResultData>> {
  return checkInByRsvpIdAction(input);
}

export async function loadRecentCheckIns(input: unknown): Promise<ActionResult<RecentCheckInsPage>> {
  return loadRecentCheckInsAction(input);
}
