import "server-only";

import { prisma } from "@/lib/db";
import { attendanceReplySchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { hashAttendanceToken, isAttendanceTokenShape } from "@/lib/attendanceToken";
import {
  asReleaseOutcome,
  attendanceReplyClosedReason,
  type AttendanceReleaseKind,
  type AttendanceReplyClosed,
  type AttendanceResponseValue,
} from "@/lib/attendanceCheck";
import { isEligibleRsvp } from "./shared";
import { planRelease, releaseKindFor } from "./release";
import { carryOutRelease, keptMessage, notifyOrganisersOfKeptPlace } from "./releaseRun";

export type AttendanceFormView = {
  eventTitle: string;
  organisationName: string;
  startDateTime: string;
  endDateTime: string;
  timezone: string;
  location: string;
  isOnline: boolean;
  accentColor: string | null;
  attendeeName: string;
  attendeeEmail: string;
  teamName: string | null;
  response: AttendanceResponseValue | null;
  respondedAt: string | null;
  note: string;
  /** What a "No" would release right now; null keeps the place (release off, or a paid ticket organisers handle). */
  releaseKind: AttendanceReleaseKind | null;
  closed: AttendanceReplyClosed | null;
};

const VIEW_SELECT = {
  rsvpId: true,
  eventId: true,
  response: true,
  respondedAt: true,
  note: true,
  rsvp: { select: { guestName: true, guestEmail: true, user: { select: { name: true, email: true } }, team: { select: { name: true } } } },
  event: {
    select: {
      title: true, status: true, startDateTime: true, endDateTime: true, timezone: true, location: true, isOnline: true,
      attendanceCheckReleaseOnDecline: true, organisation: { select: { name: true } }, page: { select: { accentColor: true } },
    },
  },
} as const;

/**
 * The form's view for a raw link token, or null for a malformed, rotated or
 * unknown token (the page answers a real 404). Only this registration's own
 * name, email and answer; never other attendees, the ticket token, the RSVP
 * id or check-in state. The digest is used to look the row up, never read.
 */
export async function resolveAttendanceCheckByToken(rawToken: string, now: Date = new Date()): Promise<AttendanceFormView | null> {
  if (!isAttendanceTokenShape(rawToken)) return null;
  const check = await prisma.attendanceCheck.findUnique({ where: { tokenHash: hashAttendanceToken(rawToken) }, select: VIEW_SELECT });
  if (!check) return null;
  const eligible = await isEligibleRsvp(prisma, check.rsvpId, check.eventId);
  const closed = attendanceReplyClosedReason({ eligible, eventStart: check.event.startDateTime, eventStatus: check.event.status, now });
  const email = check.rsvp.user?.email ?? check.rsvp.guestEmail ?? "";
  return {
    eventTitle: check.event.title,
    organisationName: check.event.organisation.name,
    startDateTime: check.event.startDateTime.toISOString(),
    endDateTime: check.event.endDateTime.toISOString(),
    timezone: check.event.timezone,
    location: check.event.location,
    isOnline: check.event.isOnline,
    accentColor: check.event.page?.accentColor ?? null,
    attendeeName: check.rsvp.user?.name?.trim() || check.rsvp.guestName?.trim() || email.split("@")[0] || "Guest",
    attendeeEmail: email,
    teamName: check.rsvp.team?.name ?? null,
    response: check.response,
    respondedAt: check.respondedAt?.toISOString() ?? null,
    note: check.note ?? "",
    releaseKind: closed ? null : await releaseKindFor(check.rsvpId, check.event.attendanceCheckReleaseOnDecline, now),
    closed,
  };
}

export type AttendanceReplyResult = { response: AttendanceResponseValue; released: boolean; releaseFailed?: string; };

/**
 * Record the guest's answer. The token is the only credential (a bearer
 * capability, rate limited per link and per address). A "No" with release on
 * follows lib/core/attendanceCheck/release.ts: the reply is committed first,
 * then any cancellation or refund request runs; a refused one leaves the
 * reply recorded with `releaseOutcome = "failed"`. A released place cannot be
 * taken back from this page.
 */
export async function respondToAttendanceCheck(input: unknown): Promise<ActionResult<AttendanceReplyResult>> {
  const parsed = attendanceReplySchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.path[0] === "note" ? issue.message : "Choose Yes or No." };
  }
  const { token, response, note } = parsed.data;
  if (await isActionRateLimited("attendanceCheckReply", token)) return { ok: false, error: "Too many attempts. Please wait a minute and try again." };

  const tokenHash = hashAttendanceToken(token);
  const check = await prisma.attendanceCheck.findUnique({
    where: { tokenHash },
    select: {
      id: true, rsvpId: true, eventId: true, response: true, releaseOutcome: true,
      rsvp: { select: { userId: true, checkInToken: true, guestName: true, user: { select: { name: true } } } },
      event: { select: { title: true, startDateTime: true, status: true, organisationId: true, attendanceCheckReleaseOnDecline: true } },
    },
  });
  if (!check) return { ok: false, error: "This link is no longer valid." };
  const eligible = await isEligibleRsvp(prisma, check.rsvpId, check.eventId);
  const closed = attendanceReplyClosedReason({ eligible, eventStart: check.event.startDateTime, eventStatus: check.event.status });
  if (closed === "cancelled") return { ok: false, error: "This event has been cancelled, so answers are closed." };
  if (closed === "started") return { ok: false, error: "The event has started, so answers are closed." };
  if (closed === "notConfirmed") return { ok: false, error: "Your registration is no longer confirmed, so there is nothing to answer." };

  const declining = response === "NOT_ATTENDING" && check.event.attendanceCheckReleaseOnDecline;
  const previous = asReleaseOutcome(check.releaseOutcome);
  // A "No" whose paid place is already with the organisers isn't handled twice.
  const alreadyHeld = declining && check.response === "NOT_ATTENDING" && previous != null && previous !== "failed";
  const now = new Date();
  const plan = declining && !alreadyHeld ? await planRelease(prisma, check.rsvpId, now) : null;
  const heldOutcome = alreadyHeld ? previous : plan?.kind === "hold" ? plan.outcome : null;

  const updated = await prisma.$transaction(async (tx) => {
    // The token must still be current (a reminder may have rotated it meanwhile).
    const write = await tx.attendanceCheck.updateMany({
      where: { id: check.id, tokenHash },
      data: { response, respondedAt: now, note: note || null, releaseOutcome: heldOutcome },
    });
    if (write.count !== 1) return false;
    if (plan?.kind === "hold") {
      await notifyOrganisersOfKeptPlace(tx, {
        organisationId: check.event.organisationId, eventId: check.eventId, eventTitle: check.event.title, rsvpId: check.rsvpId,
        guestName: check.rsvp.user?.name?.trim() || check.rsvp.guestName?.trim() || "A guest", outcome: plan.outcome,
      });
    }
    return true;
  });
  if (!updated) return { ok: false, error: "This link is no longer valid." };

  if (heldOutcome) return { ok: true, data: { response, released: false, releaseFailed: keptMessage(heldOutcome) } };
  if (!plan) return { ok: true, data: { response, released: false } };
  const outcome = await carryOutRelease({ check, plan, note, now });
  if (outcome.released) return { ok: true, data: { response, released: true } };
  return { ok: true, data: { response, released: false, releaseFailed: outcome.message } };
}

