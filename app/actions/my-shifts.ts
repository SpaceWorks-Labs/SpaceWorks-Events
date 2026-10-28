"use server";

import { z } from "zod";
import type { ActionResult } from "./org";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { prisma } from "@/lib/db";
import { applyForShift, withdrawSignup } from "@/lib/volunteer/signups";
import { checkInToShift, checkOutOfShift } from "@/lib/volunteer/attendance";
import { resolveVolunteerSelf } from "@/lib/volunteer/ticketView";

/*
 * "My shifts" on a crew ticket (docs/VOLUNTEERS.md). The crew ticket token is
 * the capability, as for crew expense claims; an account-tied ticket also
 * needs that account signed in. Volunteers act only on their own sign-ups,
 * rate limited per ticket. Audit metadata is ids only.
 */

const input = z.object({ ticketToken: z.string().min(8).max(256), action: z.enum(["apply", "withdraw", "check-in", "check-out"]), id: z.string().min(1).max(64) }).strict();

export async function myShiftAction(raw: unknown): Promise<ActionResult<{ status?: string; minutes?: number }>> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Shift not found." };
  const { ticketToken, action, id } = parsed.data;
  if (await isActionRateLimited("action", ticketToken)) return { ok: false, error: "Too many changes. Try again shortly." };
  const session = await auth();
  const self = await resolveVolunteerSelf(ticketToken, session?.user?.id);
  if (!self) return { ok: false, error: "Volunteer shifts aren't available on this ticket." };
  const result = action === "apply"
    ? await applyForShift(self, id)
    : action === "withdraw"
      ? await withdrawSignup({ kind: "self", self }, id).then((r) => (r.ok ? { ok: true as const, data: {} } : r))
      : action === "check-in"
        ? await checkInToShift({ kind: "self", self }, id).then((r) => (r.ok ? { ok: true as const, data: {} } : r))
        : await checkOutOfShift({ kind: "self", self }, id);
  if (!result.ok) return result;
  const event = await prisma.event.findUnique({ where: { id: self.eventId }, select: { organisationId: true } });
  const audited = { apply: "VOLUNTEER_SIGNUP_APPLIED", withdraw: "VOLUNTEER_SIGNUP_WITHDRAWN", "check-in": "VOLUNTEER_CHECKED_IN", "check-out": "VOLUNTEER_CHECKED_OUT" }[action];
  await recordAuditEvent({ action: audited, organisationId: event?.organisationId ?? null, targetType: action === "apply" ? "VolunteerShift" : "VolunteerShiftSignup", targetId: id, metadata: { source: "self" } });
  return { ok: true, data: result.data };
}
