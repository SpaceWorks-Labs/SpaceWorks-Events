import "server-only";

import { prisma } from "@/lib/db";
import { attendanceLinkSchema } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { attendancePath, generateAttendanceToken } from "@/lib/attendanceToken";
import { ATTENDANCE_AUDIT, isEligibleRsvp, lockOpenEvent, requireAttendanceContext, revalidatePath } from "./shared";

/**
 * One guest's link, to share by hand (Guests · People). No email is queued.
 * Only the digest is stored, so a link can't be shown twice: this always
 * issues a new one. A guest not yet asked is asked now (a later send skips
 * them); for a guest already asked the new link replaces the old one, which
 * stops working, and a queued email with it is dropped at delivery. Same
 * access, lock and start/cancel rules as sending; the raw token is returned
 * once and never logged or audited.
 */
export async function issueAttendanceLinkForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<{ path: string; replaced: boolean; }>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  const parsed = attendanceLinkSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (await isActionRateLimited("attendanceCheckLink", actorUserId)) return { ok: false, error: "Too many links created recently. Please wait a few minutes and try again." };
  const context = await requireAttendanceContext(actorUserId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!context.ok) return context;
  const eventId = context.event.id;
  const rsvpId = parsed.data.rsvpId;

  let result: { token: string; replaced: boolean; } | { error: string; };
  try {
    result = await prisma.$transaction(async (tx) => {
      // The send's lock: a concurrent send can't also ask this guest.
      const closed = await lockOpenEvent(tx, eventId);
      if (closed) return { error: closed };
      const rsvp = await tx.rSVP.findFirst({ where: { id: rsvpId, eventId }, select: { attendanceCheck: { select: { id: true } } } });
      if (!rsvp) return { error: "Guest not found." };
      if (!(await isEligibleRsvp(tx, rsvpId, eventId))) return { error: "Only confirmed guests can be asked to confirm attendance." };
      const token = generateAttendanceToken();
      const sentAt = new Date();
      if (rsvp.attendanceCheck) {
        await tx.attendanceCheck.update({ where: { id: rsvp.attendanceCheck.id }, data: { tokenHash: token.hash, sentAt } });
      } else {
        await tx.attendanceCheck.create({ data: { rsvpId, eventId, tokenHash: token.hash, sentAt } });
      }
      return { token: token.raw, replaced: rsvp.attendanceCheck != null };
    });
  } catch {
    console.error("[attendance check] link creation failed");
    return { ok: false, error: "Could not create the link. Please try again." };
  }
  if ("error" in result) return { ok: false, error: result.error };

  await recordAuditEvent({
    action: ATTENDANCE_AUDIT.linkShared, actorUserId, organisationId: context.org.id, targetType: "Event", targetId: eventId,
    metadata: { rsvpId, replaced: result.replaced },
  });
  revalidatePath(`/dashboard/${context.org.slug}/event/${eventId}`);
  return { ok: true, data: { path: attendancePath(result.token), replaced: result.replaced } };
}
