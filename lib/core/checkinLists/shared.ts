import "server-only";

import { revalidatePath } from "next/cache";
import { EventPermission, type RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canAccessEvent, canViewEventDashboard } from "@/lib/eventAccess";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import type { Bucket } from "@/lib/rateLimit";
import type { CheckInListSource } from "@/lib/checkInLists";

/** Result types and the event access check shared by the check-in list cores. */

export type CheckInListOptions = { source?: CheckInListSource };

export type CheckInListSummary = {
  id: string;
  name: string;
  sortOrder: number;
  archived: boolean;
  requiresEntryCheckIn: boolean;
};

export type ListCheckInResultData = {
  listId: string;
  listName: string;
  rsvpId: string;
  displayName: string;
  email: string | null;
  status: RsvpStatus;
  alreadyCheckedIn: boolean;
  /** When this guest was checked into the list. */
  checkedInAt: string;
  /** Entry check-in time, unchanged by list check-ins. */
  entryCheckedInAt: string | null;
  /** "Checked in to Swag" or "Already checked in to Swag at 10:42". */
  message: string;
};

export type ListLookupRow = {
  rsvpId: string;
  displayName: string;
  email: string | null;
  status: RsvpStatus;
  entryCheckedInAt: string | null;
  listCheckedInAt: string | null;
};

export type Need = "manage" | "checkIn";

export const fail = (error: string, extra: { needsForce?: boolean; fieldErrors?: Record<string, string[]> } = {}) => ({ ok: false as const, error, ...extra });

export function attendeeLabel(r: { user: { name: string | null; email: string | null } | null; guestName: string | null; guestEmail: string | null }) {
  return r.user?.name?.trim() || r.guestName?.trim() || r.user?.email || r.guestEmail || "Guest";
}

export async function resolveEvent(actorUserId: string | null, organisationSlug: string, eventId: string, need: Need, bucket: Bucket) {
  if (!actorUserId) return fail("You must be signed in.");
  if (await isActionRateLimited(bucket, actorUserId)) {
    return fail(need === "checkIn" ? "Too many check-in requests. Please try again shortly." : "Too many changes. Please try again shortly.");
  }
  const org = await prisma.organisation.findUnique({ where: { slug: organisationSlug }, select: { id: true, slug: true } });
  if (!org) return fail("Event not found.");
  const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: org.id }, select: { id: true, organisationId: true, timezone: true } });
  if (!event) return fail("Event not found.");
  const permission = need === "manage" ? EventPermission.EDIT_DETAILS : EventPermission.CHECK_IN;
  if (!(await canAccessEvent({ userId: actorUserId, organisationId: org.id, eventId: event.id, permission }))) {
    if (!(await canViewEventDashboard({ userId: actorUserId, organisationId: org.id, eventId: event.id }))) return fail("Event not found.");
    return fail(need === "manage" ? "You do not have permission to manage check-in lists." : "You do not have permission to operate check-in.");
  }
  return { ok: true as const, org, event, actorUserId };
}

export function revalidateLists(orgSlug: string, eventId: string) {
  revalidatePath(`/dashboard/${orgSlug}/event/${eventId}`);
  revalidatePath(`/dashboard/${orgSlug}/event/${eventId}/check-in`);
}
