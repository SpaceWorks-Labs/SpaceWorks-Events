"use server";

import { RsvpStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { confirmRsvpWithinCapacity } from "@/lib/rsvpCapacity";
import { rsvpTransitionSchema } from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { declineRequestedOrder, offerRequestedOrder } from "@/lib/payments/operations";
import { attendeeEmail, attendeeName, loadRsvpContext, paidRequest, paymentOperation, revalidateRsvpPaths } from "./rsvp-lifecycle/helpers";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { reacceptRsvpFor, type ReacceptStatus } from "./rsvp-lifecycle/reaccept";

/** Team registrations change status only as a whole team (docs/TEAMS.md). */
const TEAM_MEMBER_TRANSITION_ERROR = "This registration belongs to a team. Approve, reject or promote the whole team from the Teams view.";

export async function approveRsvp(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("rsvp", session.user.id)) return { ok: false, error: "Too many attendee updates. Try again shortly." };

  const parsed = rsvpTransitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, rsvpId, eventId, eventInstanceId } = parsed.data;
  const ctx = await loadRsvpContext(
    organisationSlug,
    session.user.id,
    rsvpId,
    eventId,
    eventInstanceId,
  );
  if ("error" in ctx && ctx.error) return { ok: false, error: ctx.error };
  if (!("rsvp" in ctx)) return { ok: false, error: "Invalid state." };

  const { org, rsvp } = ctx;
  if (rsvp.teamId) return { ok: false, error: TEAM_MEMBER_TRANSITION_ERROR };
  if (rsvp.status !== RsvpStatus.PENDING_APPROVAL) {
    return { ok: false, error: "Only pending requests can be approved." };
  }

  const request = await paidRequest(rsvp);
  if (request) {
    // Approval offers a paid order its seats; the tickets confirm once it's paid.
    const offered = await paymentOperation(() => offerRequestedOrder({ orderId: request.id, organisationId: org.id, actorUserId: session.user.id }));
    if (!offered.ok) return offered;
    await recordAuditEvent({ action: "RSVP_APPROVED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
    revalidateRsvpPaths(ctx.event ? { orgSlug: org.slug, eventSlug: ctx.event.slug, eventId: ctx.event.id } : { orgSlug: org.slug, eventInstanceId: ctx.instance!.id });
    return { ok: true };
  }

  if (ctx.event) {
    const to = attendeeEmail(rsvp);
    const result = await confirmRsvpWithinCapacity({
      rsvpId: rsvp.id,
      eventId: ctx.event.id,
      expectedStatuses: [RsvpStatus.PENDING_APPROVAL],
      requireOpen: true,
      ...(to ? { notification: { to, eventTitle: ctx.event.title, checkInToken: rsvp.checkInToken } } : {}),
    });
    if (result === "closed") {
      return { ok: false, error: "This event is no longer open for approvals." };
    }
    if (result === "full") {
      return {
        ok: false,
        error: "Event is at capacity. Free a spot or promote from waitlist first.",
      };
    }
    if (result !== "confirmed") return { ok: false, error: "This RSVP was changed by another organiser." };
    await recordAuditEvent({ action: "RSVP_APPROVED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
    revalidateRsvpPaths({
      orgSlug: org.slug,
      eventSlug: ctx.event.slug,
      eventId: ctx.event.id,
    });
    return { ok: true };
  }

  const instance = ctx.instance!;
  const series = instance.series;
  const to = attendeeEmail(rsvp);
  const result = await confirmRsvpWithinCapacity({
    rsvpId: rsvp.id,
    eventInstanceId: instance.id,
    expectedStatuses: [RsvpStatus.PENDING_APPROVAL],
    requireOpen: true,
    ...(to ? { notification: { to, eventTitle: series.title, checkInToken: rsvp.checkInToken } } : {}),
  });
  if (result === "closed") {
    return { ok: false, error: "This occurrence is no longer open for approvals." };
  }
  if (result === "full") {
    return {
      ok: false,
      error: "This occurrence is at capacity.",
    };
  }
  if (result !== "confirmed") return { ok: false, error: "This RSVP was changed by another organiser." };
  await recordAuditEvent({ action: "RSVP_APPROVED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
  revalidateRsvpPaths({
    orgSlug: org.slug,
    eventInstanceId: instance.id,
  });
  return { ok: true };
}

export async function rejectRsvp(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("rsvp", session.user.id)) return { ok: false, error: "Too many attendee updates. Try again shortly." };

  const parsed = rsvpTransitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, rsvpId, eventId, eventInstanceId } = parsed.data;
  const ctx = await loadRsvpContext(
    organisationSlug,
    session.user.id,
    rsvpId,
    eventId,
    eventInstanceId,
  );
  if ("error" in ctx && ctx.error) return { ok: false, error: ctx.error };
  if (!("rsvp" in ctx)) return { ok: false, error: "Invalid state." };

  const { org, rsvp } = ctx;
  if (rsvp.teamId) return { ok: false, error: TEAM_MEMBER_TRANSITION_ERROR };
  if (
    rsvp.status !== RsvpStatus.PENDING_APPROVAL &&
    rsvp.status !== RsvpStatus.WAITLISTED
  ) {
    return { ok: false, error: "This RSVP cannot be rejected." };
  }

  const request = await paidRequest(rsvp);
  if (request) {
    const declined = await paymentOperation(() => declineRequestedOrder({ orderId: request.id, organisationId: org.id, actorUserId: session.user.id }));
    if (!declined.ok) return declined;
    await recordAuditEvent({ action: "RSVP_REJECTED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
    revalidateRsvpPaths(ctx.event ? { orgSlug: org.slug, eventSlug: ctx.event.slug, eventId: ctx.event.id } : { orgSlug: org.slug, eventInstanceId: ctx.instance!.id });
    return { ok: true };
  }

  const to = attendeeEmail(rsvp);
  const rejected = await prisma.$transaction(async (tx) => {
    const result = await tx.rSVP.updateMany({
      // `teamId: null`: an RSVP that joined a team meanwhile moves only with its team.
      where: { id: rsvp.id, teamId: null, status: { in: [RsvpStatus.PENDING_APPROVAL, RsvpStatus.WAITLISTED] } },
      data: { status: RsvpStatus.REJECTED },
    });
    if (result.count === 1 && to) {
      await enqueueRsvpStatusNotification(tx, {
        to,
        organisationId: org.id,
        eventTitle: ctx.event?.title ?? ctx.instance!.series.title,
        approved: false,
        recipientName: attendeeName(rsvp),
      });
    }
    return result;
  });
  if (rejected.count !== 1) return { ok: false, error: "This RSVP was changed by another organiser." };
  emitWebhookEvent({ type: "registration.status_changed", rsvpId: rsvp.id, status: RsvpStatus.REJECTED, previousStatus: rsvp.status });

  await recordAuditEvent({ action: "RSVP_REJECTED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });

  if (ctx.event) {
    revalidateRsvpPaths({
      orgSlug: org.slug,
      eventSlug: ctx.event.slug,
      eventId: ctx.event.id,
    });
    return { ok: true };
  }

  const instance = ctx.instance!;
  revalidateRsvpPaths({
    orgSlug: org.slug,
    eventInstanceId: instance.id,
  });
  return { ok: true };
}

/** Reverses a decline; a paid registration goes back through the payment flow. */
export async function reacceptRsvp(input: unknown): Promise<ActionResult<{ status: ReacceptStatus; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  return reacceptRsvpFor(session.user.id, input);
}

export async function promoteFromWaitlist(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("rsvp", session.user.id)) return { ok: false, error: "Too many attendee updates. Try again shortly." };

  const parsed = rsvpTransitionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, rsvpId, eventId, eventInstanceId } = parsed.data;
  const ctx = await loadRsvpContext(
    organisationSlug,
    session.user.id,
    rsvpId,
    eventId,
    eventInstanceId,
  );
  if ("error" in ctx && ctx.error) return { ok: false, error: ctx.error };
  if (!("rsvp" in ctx)) return { ok: false, error: "Invalid state." };

  const { org, rsvp } = ctx;
  if (rsvp.teamId) return { ok: false, error: TEAM_MEMBER_TRANSITION_ERROR };
  if (rsvp.status !== RsvpStatus.WAITLISTED) {
    return { ok: false, error: "Only waitlisted attendees can be promoted." };
  }

  const request = await paidRequest(rsvp);
  if (request) {
    const offered = await paymentOperation(() => offerRequestedOrder({ orderId: request.id, organisationId: org.id, actorUserId: session.user.id }));
    if (!offered.ok) return offered;
    await recordAuditEvent({ action: "RSVP_WAITLIST_PROMOTED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
    revalidateRsvpPaths(ctx.event ? { orgSlug: org.slug, eventSlug: ctx.event.slug, eventId: ctx.event.id } : { orgSlug: org.slug, eventInstanceId: ctx.instance!.id });
    return { ok: true };
  }

  if (ctx.event) {
    const to = attendeeEmail(rsvp);
    const result = await confirmRsvpWithinCapacity({
      rsvpId: rsvp.id,
      eventId: ctx.event.id,
      expectedStatuses: [RsvpStatus.WAITLISTED],
      ...(to ? { notification: { to, eventTitle: ctx.event.title, checkInToken: rsvp.checkInToken } } : {}),
    });
    if (result === "full") {
      return { ok: false, error: "Event is still at capacity." };
    }
    if (result !== "confirmed") return { ok: false, error: "This RSVP was changed by another organiser." };
    await recordAuditEvent({ action: "RSVP_WAITLIST_PROMOTED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
    revalidateRsvpPaths({
      orgSlug: org.slug,
      eventSlug: ctx.event.slug,
      eventId: ctx.event.id,
    });
    return { ok: true };
  }

  const instance = ctx.instance!;
  const series = instance.series;
  const to = attendeeEmail(rsvp);
  const result = await confirmRsvpWithinCapacity({
    rsvpId: rsvp.id,
    eventInstanceId: instance.id,
    expectedStatuses: [RsvpStatus.WAITLISTED],
    ...(to ? { notification: { to, eventTitle: series.title, checkInToken: rsvp.checkInToken } } : {}),
  });
  if (result === "full") {
    return { ok: false, error: "This occurrence is still at capacity." };
  }
  if (result !== "confirmed") return { ok: false, error: "This RSVP was changed by another organiser." };
  await recordAuditEvent({ action: "RSVP_WAITLIST_PROMOTED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
  revalidateRsvpPaths({
    orgSlug: org.slug,
    eventInstanceId: instance.id,
  });
  return { ok: true };
}
