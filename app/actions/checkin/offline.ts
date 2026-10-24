import { gateCheckInForStatus } from "@/lib/checkIn";
import { prisma } from "@/lib/db";
import { offlineCheckInRosterSchema, syncOfflineCheckInsSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { commitCheckInProjection } from "@/lib/checkInMutations";
import { getCheckInDetails, getRegistrationDetails } from "@/lib/checkInDetails";
import { attendeeLabel, requireOrgMemberForEvent, revalidatePath } from "./access";
import type { OfflineCheckInRosterRow } from "../checkin";

export async function downloadOfflineCheckInRoster(
  input: unknown,
): Promise<ActionResult<{ generatedAt: string; rows: OfflineCheckInRosterRow[]; }>> {
  const parsed = offlineCheckInRosterSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid offline roster request." };
  }

  const { organisationSlug, eventId } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvps = await prisma.rSVP.findMany({
    where: { eventId: ctx.event.id, status: { in: ["CONFIRMED", "WAITLISTED", "PENDING_APPROVAL"] } },
    include: {
      user: { select: { name: true, email: true } },
      answers: { include: { field: { select: { key: true, label: true } } } },
      team: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    ok: true,
    data: {
      generatedAt: new Date().toISOString(),
      rows: rsvps.map((r) => ({
        rsvpId: r.id,
        ticketToken: r.checkInToken,
        displayName: attendeeLabel(r),
        email: r.user?.email ?? r.guestEmail,
        status: r.status,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
        checkInDetails: getCheckInDetails(r.answers),
        registrationDetails: getRegistrationDetails(r.answers),
        teamName: r.team?.name ?? null,
      })),
    },
  };
}

export async function syncOfflineCheckIns(
  input: unknown,
): Promise<ActionResult<{ syncedIds: string[]; alreadyCheckedInIds: string[]; failed: { rsvpId: string; error: string; }[]; }>> {
  const parsed = syncOfflineCheckInsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid offline check-in queue." };
  }

  const { organisationSlug, eventId, checkIns } = parsed.data;
  const ctx = await requireOrgMemberForEvent(organisationSlug, eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };

  const rsvps = await prisma.rSVP.findMany({
    where: { eventId: ctx.event.id, id: { in: checkIns.map((checkIn) => checkIn.rsvpId) } },
    select: { id: true, status: true, checkedInAt: true },
  });
  const rsvpById = new Map(rsvps.map((rsvp) => [rsvp.id, rsvp]));
  const syncedIds: string[] = [];
  const alreadyCheckedInIds: string[] = [];
  const failed: { rsvpId: string; error: string; }[] = [];
  const seenRsvpIds = new Set<string>();

  for (const checkIn of checkIns) {
    if (seenRsvpIds.has(checkIn.rsvpId)) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "Duplicate offline check-in entry." });
      continue;
    }
    seenRsvpIds.add(checkIn.rsvpId);
    const rsvp = rsvpById.get(checkIn.rsvpId);
    if (!rsvp) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "RSVP not found for this event." });
      continue;
    }
    const gate = gateCheckInForStatus(rsvp.status, checkIn.force);
    if (!gate.ok) {
      failed.push({ rsvpId: checkIn.rsvpId, error: gate.reason });
      continue;
    }
    const checkedInAt = new Date(checkIn.checkedInAt);
    const earliest = ctx.event.startDateTime.getTime() - 24 * 60 * 60_000;
    const latest = Math.min(Date.now() + 5 * 60_000, ctx.event.endDateTime.getTime() + 60 * 60_000);
    if (checkedInAt.getTime() < earliest || checkedInAt.getTime() > latest) {
      failed.push({ rsvpId: checkIn.rsvpId, error: "Offline check-in time is outside the event operating window." });
      continue;
    }
    if (rsvp.checkedInAt) {
      alreadyCheckedInIds.push(rsvp.id);
      continue;
    }
    const committed = await commitCheckInProjection({
      rsvpId: rsvp.id,
      actorUserId: ctx.actorUserId,
      source: "offline-sync",
      checkedInAt,
      force: checkIn.force,
    });
    if (committed.state === "checked-in") {
      syncedIds.push(rsvp.id);
    } else if (committed.state === "already-checked-in") {
      alreadyCheckedInIds.push(rsvp.id);
    } else {
      const currentGate = committed.state === "ineligible" ? gateCheckInForStatus(committed.status, checkIn.force) : null;
      failed.push({
        rsvpId: rsvp.id,
        error: committed.state === "missing" ? "RSVP not found for this event." : currentGate?.ok ? "Check-in could not be completed." : currentGate!.reason,
      });
    }
  }

  if (syncedIds.length > 0) {
    revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.event.id}`);
    revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.event.id}/check-in`);
  }

  return { ok: true, data: { syncedIds, alreadyCheckedInIds, failed } };
}
