import { EventPrivacyType, EventStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isValidAttendeeName } from "@/lib/validators";
import type { ActionResult } from "@/app/actions/org";
import { reserveRsvp } from "./reserve";
import { publicCountField } from "@/lib/publicRegistrationCount";
import { sellsTickets, seriesOrderTarget, submitTicketOrder } from "./orders";
import { isRsvpTargetClosedError, requestedItems, resolveAttendeeEmail, RsvpInviteRequiredError, type OrderRequest } from "./shared";

export async function submitInstanceRsvp(params: {
  org: { id: string; slug: string };
  eventInstanceId: string;
  userId: string | null;
  guestEmail: string | null;
  guestName?: string | null;
  name?: string | null;
  request: OrderRequest;
}): Promise<ActionResult<{ count?: number; status: RsvpStatus; ticketToken: string; orderToken?: string; checkoutUrl?: string | null }>> {
  const { org, eventInstanceId, userId } = params;

  const instance = await prisma.eventInstance.findFirst({
    where: { id: eventInstanceId },
    include: {
      series: true,
    },
  });
  if (!instance || instance.series.organisationId !== org.id) {
    return { ok: false, error: "Event not found." };
  }

  if (
    instance.series.status !== EventStatus.PUBLISHED ||
    instance.endDateTime <= new Date() ||
    instance.cancelledAt
  ) {
    return { ok: false, error: "This event is not open for RSVP." };
  }

  const series = instance.series;
  const emailRes = userId
    ? await resolveAttendeeEmail(userId, undefined)
    : { email: params.guestEmail! };

  if ("error" in emailRes) return { ok: false, error: emailRes.error };

  if (series.privacyType === EventPrivacyType.INVITE_ONLY) {
    if (!userId) {
      return { ok: false, error: "This event is invite-only. Sign in with the invited account to register." };
    }
    const ok = await prisma.seriesInvite.findUnique({
      where: {
        eventSeriesId_email: {
          eventSeriesId: series.id,
          email: emailRes.email,
        },
      },
    });
    if (!ok) {
      return {
        ok: false,
        error: "This event is invite-only. Use the email you were invited with.",
      };
    }
  }

  const attendeeKey = userId
    ? `user:${userId}`
    : `guest:${emailRes.email}`;

  // A series that sells tickets registers through orders, for one date or a pass.
  const items = requestedItems(params.request);
  if (items.length > 0 || await sellsTickets({ eventSeriesId: series.id })) {
    if (items.length === 0) return { ok: false, error: "Choose a ticket." };
    const target = await seriesOrderTarget(series.id, instance.id, items);
    if ("error" in target) return { ok: false, error: target.error };
    let name = params.guestName?.trim() ?? "";
    let setUserName: string | null = null;
    if (userId) {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      const existingName = user?.name?.trim() ?? "";
      name = params.name?.trim() || existingName;
      if (!existingName && name) setUserName = name;
    }
    if (!name) return { ok: false, error: "Name is required." };
    if (!isValidAttendeeName(name)) return { ok: false, error: "Enter a valid name." };
    return submitTicketOrder({
      target,
      organisationId: series.organisationId,
      request: params.request,
      buyer: { userId, email: emailRes.email, name, attendeeKey },
      answers: [],
      setUserName,
    });
  }

  try {
    let reservation: Awaited<ReturnType<typeof reserveRsvp>>;
    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });
      const existingName = user?.name?.trim() ?? "";
      const submittedName = params.name?.trim() ?? "";
      if (!existingName && !submittedName) {
        return { ok: false, error: "Name is required." };
      }
      if (!isValidAttendeeName(submittedName || existingName)) {
        return { ok: false, error: "Enter a valid name." };
      }

      reservation = await reserveRsvp({
        target: { eventInstanceId: instance.id },
        capacity: instance.capacity ?? series.capacity,
        privacyType: series.privacyType,
        notification: { to: emailRes.email, eventTitle: series.title },
        data: {
            eventInstanceId: instance.id,
            userId,
            guestEmail: null,
            attendeeKey,
          },
        afterCreate: async (tx) => {
          if (!existingName && submittedName) {
            await tx.user.update({
            where: { id: userId },
            data: { name: submittedName },
          });
          }
        },
      });
    } else {
      const guestName = params.guestName?.trim() ?? "";
      if (!guestName) return { ok: false, error: "Name is required." };
      if (!isValidAttendeeName(guestName)) {
        return { ok: false, error: "Enter a valid name." };
      }
      reservation = await reserveRsvp({
        target: { eventInstanceId: instance.id },
        capacity: instance.capacity ?? series.capacity,
        privacyType: series.privacyType,
        notification: { to: emailRes.email, eventTitle: series.title },
        data: {
          eventInstanceId: instance.id,
          userId: null,
          guestEmail: emailRes.email,
          guestName,
          attendeeKey,
        },
      });
    }

    return {
      ok: true,
      data: { ...publicCountField(reservation.count), status: reservation.status, ticketToken: reservation.checkInToken },
    };
  } catch (e: unknown) {
    if (isRsvpTargetClosedError(e)) return { ok: false, error: "This event is not open for RSVP." };
    if (e instanceof RsvpInviteRequiredError) return { ok: false, error: e.message };
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "P2002"
    ) {
      return { ok: false, error: "You have already RSVP’d for this event." };
    }
    console.error("[rsvp] occurrence submission failed");
    return { ok: false, error: "Could not save your RSVP." };
  }
}
