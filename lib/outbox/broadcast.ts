import "server-only";

/** Event broadcast email: each recipient's copy, and the organiser's test send. */

import { Prisma, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendEventBroadcast } from "@/lib/email";
import { broadcastHtmlToText, renderBroadcastHtml, renderBroadcastTemplate, sampleBroadcastVariables } from "@/lib/broadcastTemplate";
import { broadcastBrandFor, broadcastEventUrl, broadcastTicketUrl, rsvpMatchesBroadcastAudience } from "@/lib/eventBroadcast";
import { isBroadcastDesign } from "@/lib/email/broadcastDesigns";
import { PermanentOutboxError, asEventBroadcastPayload, asEventBroadcastTestPayload } from "./payloads";
import { broadcastEventSelect, broadcastVariablesFor } from "./context";

/** Sends one `event-broadcast` copy. "dropped" means it no longer applies and must not be retried. */
export async function deliverEventBroadcast(value: Prisma.JsonValue, stableMessageId: string): Promise<"sent" | "dropped"> {
  const payload = asEventBroadcastPayload(value);
  if (!payload) throw new PermanentOutboxError();
  const [broadcast, rsvp] = await Promise.all([
    prisma.eventBroadcast.findUnique({
      where: { id: payload.broadcastId },
      select: { subject: true, body: true, design: true, statuses: true, attendance: true, eventId: true, event: { select: broadcastEventSelect } },
    }),
    prisma.rSVP.findUnique({
      where: { id: payload.rsvpId },
      select: { eventId: true, status: true, checkedInAt: true, checkInToken: true, guestName: true, user: { select: { name: true } } },
    }),
  ]);
  // The broadcast or registration was removed, or the registration no
  // longer belongs to the audience it was selected for. Drop silently
  // rather than sending wording that no longer applies.
  if (!broadcast || !rsvp || rsvp.eventId !== broadcast.eventId || !rsvpMatchesBroadcastAudience(rsvp, broadcast)) {
    return "dropped";
  }
  const variables = broadcastVariablesFor(broadcast.event, {
    name: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || null,
    ticketUrl: rsvp.status === RsvpStatus.CONFIRMED ? broadcastTicketUrl(rsvp.checkInToken) : null,
  });
  const bodyHtml = renderBroadcastHtml(broadcast.body, variables);
  await sendEventBroadcast({
    to: payload.to,
    subject: renderBroadcastTemplate(broadcast.subject, variables),
    bodyHtml,
    bodyText: broadcastHtmlToText(bodyHtml),
    eventTitle: broadcast.event.title,
    organisationName: broadcast.event.organisation.name,
    design: isBroadcastDesign(broadcast.design) ? broadcast.design : undefined,
    brand: broadcastBrandFor(broadcast.event),
    messageId: stableMessageId,
  });
  return "sent";
}

/** Sends one `event-broadcast-test`. "dropped" means the event is gone and the test must not be retried. */
export async function deliverEventBroadcastTest(value: Prisma.JsonValue, stableMessageId: string): Promise<"sent" | "dropped"> {
  const payload = asEventBroadcastTestPayload(value);
  if (!payload) throw new PermanentOutboxError();
  const event = await prisma.event.findUnique({ where: { id: payload.eventId }, select: broadcastEventSelect });
  if (!event) {
    return "dropped";
  }
  const variables = sampleBroadcastVariables({
    title: event.title,
    startDateTime: event.startDateTime,
    timezone: event.timezone,
    location: event.location,
    isOnline: event.isOnline,
    eventUrl: broadcastEventUrl(event.organisation.slug, event.slug),
    organisationName: event.organisation.name,
  }, payload.recipientName ?? null);
  // If the organiser receiving the test is confirmed for this event themselves,
  // the ticket button opens their own ticket, so the whole flow can be checked.
  // (Tests only ever go to the signed-in organiser's own verified address.)
  const ownRsvp = await prisma.rSVP.findFirst({
    where: {
      eventId: payload.eventId,
      status: RsvpStatus.CONFIRMED,
      OR: [{ user: { email: { equals: payload.to, mode: "insensitive" } } }, { guestEmail: { equals: payload.to, mode: "insensitive" } }],
    },
    select: { checkInToken: true },
  });
  if (ownRsvp) variables.ticketLink = broadcastTicketUrl(ownRsvp.checkInToken);
  const bodyHtml = renderBroadcastHtml(payload.body, variables);
  await sendEventBroadcast({
    to: payload.to,
    subject: `[Test] ${renderBroadcastTemplate(payload.subject, variables)}`,
    bodyHtml,
    bodyText: broadcastHtmlToText(bodyHtml),
    eventTitle: event.title,
    organisationName: event.organisation.name,
    design: isBroadcastDesign(payload.design) ? payload.design : undefined,
    brand: broadcastBrandFor(event),
    messageId: stableMessageId,
  });
  return "sent";
}
