import "server-only";

/** Mentor Desk CSV rows (docs/MENTOR_DESK.md): bounded batches, no help text, no contact details. */

import { prisma } from "@/lib/db";
import { zonedIsoWithOffset } from "@/lib/timeZone";

export type MentorDeskExportView = "requests" | "assignments";

export const MENTOR_DESK_EXPORT_HEADERS: Record<MentorDeskExportView, readonly string[]> = {
  requests: ["Created", "Category", "Team or participant", "Origin", "Status", "Claimed by", "First claimed", "Resolved", "Rating"],
  assignments: ["Team", "Mentor", "Round", "Mode", "Status", "Manual override", "Active from", "Ended"],
};

export function parseMentorDeskExportView(params: URLSearchParams): MentorDeskExportView | null {
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "view")) return null;
  const view = params.get("view") ?? "requests";
  return view === "requests" || view === "assignments" ? view : null;
}

const BATCH = 500;

export async function* mentorDeskExportBatches(eventId: string, timezone: string, view: MentorDeskExportView): AsyncGenerator<string[][]> {
  const at = (d: Date | null) => (d ? zonedIsoWithOffset(d, timezone) : "");
  let cursor: string | undefined;
  for (;;) {
    const page = { take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" as const } };
    if (view === "requests") {
      const rows = await prisma.helpRequest.findMany({ where: { eventId }, ...page, select: { id: true, createdAt: true, origin: true, status: true, firstClaimedAt: true, resolvedAt: true, rating: true, category: { select: { label: true } }, team: { select: { name: true } }, rsvp: { select: { guestName: true, user: { select: { name: true } } } }, claimedBy: { select: { name: true } } } });
      if (rows.length === 0) return;
      yield rows.map((r) => [at(r.createdAt), r.category.label, r.team?.name ?? (r.rsvp?.user?.name?.trim() || r.rsvp?.guestName?.trim() || "Participant"), r.origin, r.status, r.claimedBy?.name ?? "", at(r.firstClaimedAt), at(r.resolvedAt), r.rating ? String(r.rating) : ""]);
      cursor = rows.at(-1)!.id;
    } else {
      const rows = await prisma.mentorTeamAssignment.findMany({ where: { eventId }, ...page, select: { id: true, mode: true, status: true, manualOverride: true, activeFrom: true, endedAt: true, team: { select: { name: true } }, mentor: { select: { name: true } }, round: { select: { label: true } } } });
      if (rows.length === 0) return;
      yield rows.map((r) => [r.team.name, r.mentor.name ?? "Mentor", r.round?.label ?? "Event-wide", r.mode, r.status, r.manualOverride ? "Yes" : "No", at(r.activeFrom), at(r.endedAt)]);
      cursor = rows.at(-1)!.id;
    }
  }
}
