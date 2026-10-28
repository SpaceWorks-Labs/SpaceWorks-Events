"use server";

import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { recordAuditEvent } from "@/lib/audit";
import type { ActionResult } from "./org";
import { z } from "zod";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { EventPrivacyType, RegistrationMode, RsvpStatus } from "@prisma/client";
import { emitTeamWebhooks, promoteOldestWaitlistedUnit, settleTeamAfterMemberLeft, type RegistrationStatusWebhook } from "@/lib/teamUnits";
import { NOT_FROM_PAID_ORDER } from "@/lib/rsvpCapacity";
import { fillFromWaitlist } from "@/lib/payments/operations";
import { lockSeriesDates, seatTargetOf } from "@/lib/payments/targets";
import { noticeEach, noticeSubject, personEmail } from "@/lib/notices";
import { emitWebhookEvent, type RsvpWebhookSnapshot } from "@/lib/webhooks/emit";
import { notifyChat } from "@/lib/chat/notify";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

const cancelRsvpSchema = z.object({ checkInToken: z.string().trim().min(8).max(256) }).strict();

/**
 * Cancel an RSVP.  The caller must either:
 *  – be the logged-in user who owns the RSVP, OR
 *  – supply the correct `checkInToken` (for guest cancellation).
 *
 * When a CONFIRMED RSVP is cancelled and there are WAITLISTED RSVPs,
 * the oldest waitlisted RSVP is auto-promoted to CONFIRMED.
 */
export async function cancelRsvp(input: unknown): Promise<ActionResult<{ cancelled: true; }>> {
  const parsed = cancelRsvpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Missing token." };
  }
  const { checkInToken } = parsed.data;
  if (await isActionRateLimited("rsvp", checkInToken)) return { ok: false, error: "Too many cancellation attempts. Please try again shortly." };

  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: checkInToken.trim() },
    include: {
      event: {
        select: {
          id: true,
          slug: true,
          title: true,
          privacyType: true,
          organisation: { select: { id: true, slug: true } },
        },
      },
      eventInstance: {
        select: {
          id: true,
          eventSeriesId: true,
          series: {
            select: { title: true, privacyType: true, organisation: { select: { id: true, slug: true } } },
          },
        },
      },
    },
  });

  if (!rsvp) {
    return { ok: false, error: "RSVP not found." };
  }

  // Authorization: must own the RSVP
  const session = await auth();
  const isOwner =
    (rsvp.userId && session?.user?.id === rsvp.userId) ||
    // Guest flow: the token itself is the auth proof
    (!rsvp.userId && !!checkInToken);

  if (!isOwner) {
    return { ok: false, error: "You can only cancel your own registration." };
  }
  // A crew ticket belongs to the crew list (docs/CREW.md), which organisers manage.
  if (rsvp.isCrew) return { ok: false, error: "You're on this event's crew. Ask an organiser to remove you from the crew." };

  let promotedId: string | null = null;
  const promotedWebhooks: RegistrationStatusWebhook[] = [];
  let removed: { snapshot: RsvpWebhookSnapshot; previousStatus: RsvpStatus; } | null = null;
  const cancellation = await prisma.$transaction(async (tx) => {
    if (rsvp.eventId) {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${rsvp.eventId} FOR UPDATE`;
    } else if (rsvp.eventInstanceId && rsvp.eventInstance) {
      await lockSeriesDates(tx, rsvp.eventInstance.eventSeriesId, [rsvp.eventInstanceId], new Date());
    }
    const current = await tx.rSVP.findUnique({ where: { id: rsvp.id }, include: { user: { select: { email: true } }, order: { select: { id: true, status: true, buyerEmail: true, payments: { where: { status: { in: ["PAID_ONLINE", "PAID_OFFLINE"] } }, select: { id: true } } } } } });
    if (!current) return { error: "RSVP not found." };
    if (current.isCrew) return { error: "You're on this event's crew. Ask an organiser to remove you from the crew." };
    if (current.checkedInAt) return { error: "Cannot cancel — you have already checked in." };
    // Money was taken: refunds follow the order's policy, from the order page.
    if (current.order && current.order.payments.length > 0) return { error: "Paid tickets are cancelled from the order page, under the event's refund policy.", code: "PAID_ORDER" as const };
    const title = rsvp.event?.title ?? rsvp.eventInstance!.series.title;
    const organisationId = rsvp.event?.organisation.id ?? rsvp.eventInstance!.series.organisation.id;
    if (current.order?.status === "REQUESTED") {
      // A paid request is withdrawn as a whole; nothing was charged.
      await tx.order.update({ where: { id: current.order.id }, data: { status: "CANCELLED" } });
      await tx.rSVP.deleteMany({ where: { orderId: current.order.id } });
      await noticeEach(tx, [current.order.buyerEmail], { organisationId, subject: noticeSubject("Request withdrawn", title), lines: [`Your request to join ${title} was withdrawn. Nothing was charged.`] });
      return { error: null };
    }
    if (current.order?.status === "PENDING") {
      // A held order is released as a whole: ending its hold lets the
      // scheduler close the payment page before the seats go back on sale.
      const now = new Date();
      await tx.order.update({ where: { id: current.order.id }, data: { holdExpiresAt: now } });
      await tx.rSVP.updateMany({ where: { orderId: current.order.id, status: "PENDING_PAYMENT" }, data: { holdExpiresAt: now } });
      return { error: null };
    }
    await tx.rSVP.delete({ where: { id: current.id } });
    removed = { previousStatus: current.status, snapshot: { id: current.id, eventId: current.eventId, eventInstanceId: current.eventInstanceId, userId: current.userId, guestName: current.guestName, createdAt: current.createdAt, checkedInAt: current.checkedInAt } };
    const to = personEmail(current);
    if (to) {
      const what = current.status === "WAITLISTED" ? "left the waitlist for" : current.status === "PENDING_APPROVAL" ? "withdrawn your request to join" : "cancelled your place at";
      await notifyChat(tx, organisationId, "cancellation", `${current.guestName?.trim() || "A guest"} cancelled their place at ${title}.`);
      await noticeEach(tx, [to], { organisationId, subject: noticeSubject("Cancelled", title), lines: [`You've ${what} ${title}. Your ticket no longer works.`, "Changed your mind? Register again from the event page if places are still open."] });
    }
    // TEAM events (docs/TEAMS.md): the freed thing is a unit. A member frees
    // nothing unless they were the last one (the empty team is deleted); a
    // leader's leadership passes to the longest-standing member.
    if (current.eventId) {
      const event = await tx.event.findUnique({ where: { id: current.eventId }, select: { id: true, title: true, capacity: true, privacyType: true, registrationMode: true } });
      if (event?.registrationMode === RegistrationMode.TEAM) {
        let freedUnit = !current.teamId && current.status === RsvpStatus.CONFIRMED;
        if (current.teamId) freedUnit = (await settleTeamAfterMemberLeft(tx, { teamId: current.teamId, eventId: event.id, leftRsvpId: current.id })).freedConfirmedUnit;
        // A promoted team raises one webhook per member; a promoted solo RSVP, one.
        const promotedUnit = freedUnit ? await promoteOldestWaitlistedUnit(tx, event) : null;
        if (promotedUnit) promotedWebhooks.push(...promotedUnit.webhooks);
        return { error: null };
      }
    }
    const privacyType = rsvp.event?.privacyType ?? rsvp.eventInstance?.series.privacyType;
    // A freed seat on an event, or on a date of a series that sells tickets,
    // is offered after commit, paid requests included.
    const sold = current.eventInstanceId ? await tx.ticketType.count({ where: { eventSeriesId: rsvp.eventInstance!.eventSeriesId } }) > 0 : true;
    const freed = seatTargetOf(current);
    if (current.status === "CONFIRMED" && freed && (current.eventId || sold)) return { error: null, freed };
    if (current.status === "CONFIRMED" && privacyType !== EventPrivacyType.APPROVAL_REQUIRED) {
      const target = current.eventId ? { eventId: current.eventId } : { eventInstanceId: current.eventInstanceId! };
      const nextWaitlisted = await tx.rSVP.findFirst({
        // Tickets from paid orders are confirmed only by payment, never by promotion.
        where: { ...target, status: "WAITLISTED", ...NOT_FROM_PAID_ORDER },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { email: true } } },
      });
      if (nextWaitlisted) {
        const promoted = await tx.rSVP.updateMany({
          where: { id: nextWaitlisted.id, status: "WAITLISTED" },
          data: { status: "CONFIRMED" },
        });
        if (promoted.count === 1) promotedId = nextWaitlisted.id;
        const to = nextWaitlisted.user?.email?.trim() || nextWaitlisted.guestEmail;
        if (promoted.count === 1 && to) {
          await enqueueRsvpStatusNotification(tx, {
            to,
            eventTitle: rsvp.event?.title ?? rsvp.eventInstance!.series.title,
            approved: true,
            checkInToken: nextWaitlisted.checkInToken,
          });
        }
      }
    }
    return { error: null };
  });
  if (cancellation.error) return { ok: false, error: cancellation.error, ...("code" in cancellation && cancellation.code ? { code: cancellation.code } : {}) };
  const cancelled = removed as { snapshot: RsvpWebhookSnapshot; previousStatus: RsvpStatus; } | null;
  if (cancelled) emitWebhookEvent({ type: "registration.status_changed", rsvpId: cancelled.snapshot.id, status: "CANCELLED", previousStatus: cancelled.previousStatus, snapshot: cancelled.snapshot });
  if (promotedId) emitWebhookEvent({ type: "registration.status_changed", rsvpId: promotedId, status: RsvpStatus.CONFIRMED, previousStatus: RsvpStatus.WAITLISTED });
  emitTeamWebhooks(promotedWebhooks);
  if ("freed" in cancellation && cancellation.freed) await fillFromWaitlist(cancellation.freed);

  await recordAuditEvent({
    action: "RSVP_CANCELLED",
    actorUserId: session?.user?.id ?? null,
    organisationId: rsvp.event?.organisation.id ?? rsvp.eventInstance?.series.organisation.id,
    targetType: "RSVP",
    targetId: rsvp.id,
  });

  // Revalidate public pages
  const orgSlug =
    rsvp.event?.organisation.slug ??
    rsvp.eventInstance?.series.organisation.slug;
  if (orgSlug) {
    revalidatePath(`/${orgSlug}`);
    if (rsvp.event) {
      revalidatePath(`/${orgSlug}/${rsvp.event.slug}`);
    }
  }

  return { ok: true, data: { cancelled: true } };
}
