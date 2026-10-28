import "server-only";

import { EventStatus } from "@prisma/client";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/app/actions/org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { canPublishEvents, getMembership } from "@/lib/permissions";
import { isRegistrationClosed, registrationClosesAt } from "@/lib/registrationCutoff";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { forUser } from "./actor";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

/*
 * Close or reopen sign-ups for a standalone event from a mobile app. Closing
 * keeps the organiser's configured cutoff in a snapshot and pins the cutoff to
 * min(now, start) so the event still passes the dashboard's "close on or
 * before the start" rule. Reopening is possible only after such a close and
 * restores the snapshot exactly. Saving the dashboard event form clears the
 * snapshot (app/actions/event.ts), so the form's explicit value wins.
 * Permission (organisation OWNER/ADMIN), rate limit and revalidation match the
 * dashboard event form.
 */

export const registrationWindowSchema = z.object({
  organisationSlug: z.string().trim().min(1).max(120),
  eventId: z.string().trim().min(1).max(128),
  open: z.boolean(),
}).strict();

export type RegistrationWindowState = {
  registrationOpen: boolean;
  registrationClosesAt: string | null;
  registrationClosedReason: string | null;
  registrationManuallyClosed: boolean;
};

type CutoffFields = {
  status: EventStatus;
  startDateTime: Date;
  endDateTime: Date;
  registrationClosesAt: Date | null;
  registrationLeadMinutes: number | null;
  registrationManuallyClosedAt?: Date | null;
};

/** Why registration is closed (UI-safe), or null when it is open. Mirrors the public page's rule. */
export function registrationClosedReason(event: CutoffFields, now = new Date()): string | null {
  if (event.status === EventStatus.CANCELLED) return "This event has been cancelled.";
  if (event.status !== EventStatus.PUBLISHED) return "Registration is not open yet.";
  if (event.endDateTime <= now) return "This event has ended.";
  if (isRegistrationClosed(event, now)) return "Registration has closed.";
  return null;
}

export function registrationWindowState(event: CutoffFields, now = new Date()): RegistrationWindowState {
  const reason = registrationClosedReason(event, now);
  return {
    registrationOpen: reason === null,
    registrationClosesAt: registrationClosesAt(event)?.toISOString() ?? null,
    registrationClosedReason: reason,
    registrationManuallyClosed: Boolean(event.registrationManuallyClosedAt),
  };
}

/** The cutoff a manual close stores: now, but never after the event starts. */
export function manualCloseCutoff(startDateTime: Date, now: Date) {
  return startDateTime < now ? startDateTime : now;
}

const stateSelect = {
  status: true,
  startDateTime: true,
  endDateTime: true,
  registrationClosesAt: true,
  registrationLeadMinutes: true,
  registrationManuallyClosedAt: true,
  registrationCutoffBeforeManualClose: true,
  registrationLeadBeforeManualClose: true,
} as const;

export const NOTHING_TO_REOPEN = "Sign-ups were not closed from the app, so there is nothing to reopen. Change the registration cutoff on the website.";

/** Close or reopen sign-ups for `actorUserId`, who must be this request's actor (lib/core/actor.ts). */
export function setRegistrationWindowForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<RegistrationWindowState>> {
  return forUser(actorUserId, () => setRegistrationWindow(actorUserId, input));
}

async function setRegistrationWindow(
  actorUserId: string | null,
  input: unknown,
): Promise<ActionResult<RegistrationWindowState>> {
  if (!actorUserId) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("action", actorUserId)) return { ok: false, error: "Too many updates. Please try again later." };
  const parsed = registrationWindowSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid registration update." };

  const org = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug }, select: { id: true, slug: true } });
  if (!org) return { ok: false, error: "Organisation not found." };
  const membership = await getMembership(actorUserId, org.id);
  if (!canPublishEvents(membership)) return { ok: false, error: "You do not have permission to edit events." };
  const target = await prisma.event.findFirst({ where: { id: parsed.data.eventId, organisationId: org.id }, select: { id: true, slug: true } });
  if (!target) return { ok: false, error: "Event not found." };

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${target.id} FOR UPDATE`;
    const current = await tx.event.findUniqueOrThrow({ where: { id: target.id }, select: stateSelect });
    if (parsed.data.open) {
      if (!current.registrationManuallyClosedAt) return { error: NOTHING_TO_REOPEN } as const;
      const restored = await tx.event.update({
        where: { id: target.id },
        data: {
          registrationClosesAt: current.registrationCutoffBeforeManualClose,
          registrationLeadMinutes: current.registrationLeadBeforeManualClose,
          registrationManuallyClosedAt: null,
          registrationCutoffBeforeManualClose: null,
          registrationLeadBeforeManualClose: null,
        },
        select: stateSelect,
      });
      return { event: restored } as const;
    }
    const closed = await tx.event.update({
      where: { id: target.id },
      data: {
        registrationClosesAt: manualCloseCutoff(current.startDateTime, now),
        registrationLeadMinutes: null,
        // Closing twice keeps the original snapshot, never the manual cutoff.
        ...(current.registrationManuallyClosedAt
          ? {}
          : {
              registrationManuallyClosedAt: now,
              registrationCutoffBeforeManualClose: current.registrationClosesAt,
              registrationLeadBeforeManualClose: current.registrationLeadMinutes,
            }),
      },
      select: stateSelect,
    });
    return { event: closed } as const;
  });
  if ("error" in result && typeof result.error === "string") return { ok: false, error: result.error };
  const event = result.event!;

  await recordAuditEvent({
    action: parsed.data.open ? "EVENT_REGISTRATION_REOPENED" : "EVENT_REGISTRATION_CLOSED",
    actorUserId,
    organisationId: org.id,
    targetType: "Event",
    targetId: target.id,
  });
  revalidatePath(`/${org.slug}`);
  revalidatePath(`/${org.slug}/${target.slug}`);
  revalidatePath(`/dashboard/${org.slug}`);
  revalidatePath(`/dashboard/${org.slug}/event/${target.id}`);
  return { ok: true, data: registrationWindowState(event, now) };
}
