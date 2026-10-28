import "server-only";

import { prisma } from "@/lib/db";
import { attendanceReplySchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { hashAttendanceToken } from "@/lib/attendanceToken";
import { asReleaseOutcome, attendanceReplyClosedReason, type AttendanceResponseValue } from "@/lib/attendanceCheck";
import { isEligibleRsvp } from "./shared";
import { planRelease } from "./release";
import { carryOutRelease, keptMessage, notifyOrganisersOfKeptPlace, withdrawRefundRequestOnYes } from "./releaseRun";

export type AttendanceReplyResult = { response: AttendanceResponseValue; released: boolean; releaseFailed?: string; };

const NO_LONGER_VALID = { ok: false as const, error: "This link is no longer valid." };

const CHECK_SELECT = {
  id: true, rsvpId: true, eventId: true, response: true, respondedAt: true, releaseOutcome: true,
  organisersNotifiedAt: true, refundRequestOpenedAt: true, refundRequestId: true,
  rsvp: { select: { userId: true, checkInToken: true, guestName: true, user: { select: { name: true } } } },
  event: { select: { title: true, startDateTime: true, status: true, organisationId: true, attendanceCheckReleaseOnDecline: true } },
} as const;

/**
 * Another window answered at the same moment and won the write: report what
 * is stored now instead of running the release a second time.
 */
async function currentAnswer(tokenHash: string): Promise<ActionResult<AttendanceReplyResult>> {
  const current = await prisma.attendanceCheck.findUnique({ where: { tokenHash }, select: { response: true, releaseOutcome: true } });
  if (!current?.response) return NO_LONGER_VALID;
  const outcome = asReleaseOutcome(current.releaseOutcome);
  return { ok: true, data: { response: current.response, released: false, ...(outcome ? { releaseFailed: keptMessage(outcome) } : {}) } };
}

/**
 * Record the guest's answer. The token is the only credential (a bearer
 * capability, rate limited per link and per address). The write is guarded by
 * the answer it replaces (response and its time), so of two windows answering
 * at once only one plans and runs a release. A "No" with release on follows
 * lib/core/attendanceCheck/release.ts after the reply commits; a refused
 * release leaves the reply recorded with `releaseOutcome = "failed"`. The
 * organiser notice and the refund request happen at most once per check, and
 * a "Yes" withdraws a refund request this check opened while it is still open.
 * A released place cannot be taken back from this page.
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
  const check = await prisma.attendanceCheck.findUnique({ where: { tokenHash }, select: CHECK_SELECT });
  if (!check) return NO_LONGER_VALID;
  const eligible = await isEligibleRsvp(prisma, check.rsvpId, check.eventId);
  const closed = attendanceReplyClosedReason({ eligible, eventStart: check.event.startDateTime, eventStatus: check.event.status });
  if (closed === "cancelled") return { ok: false, error: "This event has been cancelled, so answers are closed." };
  if (closed === "started") return { ok: false, error: "The event has started, so answers are closed." };
  if (closed === "notConfirmed") return { ok: false, error: "Your registration is no longer confirmed, so there is nothing to answer." };

  const now = new Date();
  const guestName = check.rsvp.user?.name?.trim() || check.rsvp.guestName?.trim() || "A guest";
  const plan = response === "NOT_ATTENDING" && check.event.attendanceCheckReleaseOnDecline ? await planRelease(prisma, check.rsvpId, now) : null;
  const heldOutcome = plan?.kind === "hold" ? plan.outcome : null;
  const notify = plan?.kind === "hold" && check.organisersNotifiedAt == null;

  const updated = await prisma.$transaction(async (tx) => {
    // The token must still be current, and the answer the one this request read.
    const write = await tx.attendanceCheck.updateMany({
      where: { id: check.id, tokenHash, response: check.response, respondedAt: check.respondedAt },
      data: { response, respondedAt: now, note: note || null, releaseOutcome: heldOutcome, ...(notify ? { organisersNotifiedAt: now } : {}) },
    });
    if (write.count !== 1) return false;
    if (notify && plan?.kind === "hold") {
      await notifyOrganisersOfKeptPlace(tx, { organisationId: check.event.organisationId, eventId: check.eventId, eventTitle: check.event.title, rsvpId: check.rsvpId, guestName, outcome: plan.outcome });
    }
    return true;
  });
  if (!updated) return currentAnswer(tokenHash);

  if (response === "ATTENDING") await withdrawRefundRequestOnYes(check, guestName, now);
  if (heldOutcome) return { ok: true, data: { response, released: false, releaseFailed: keptMessage(heldOutcome) } };
  if (!plan) return { ok: true, data: { response, released: false } };
  const outcome = await carryOutRelease({ check, plan, note, guestName, now });
  if (outcome.released) return { ok: true, data: { response, released: true } };
  return { ok: true, data: { response, released: false, releaseFailed: outcome.message } };
}
