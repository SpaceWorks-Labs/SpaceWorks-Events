import "server-only";

/** The worker's batch: claim, send as the right sender, then mark sent, retry or drop. */

import { OutboxStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendApprovalNotification, sendCollaboratorInvitation, sendEventBroadcast, sendEventInvitation, sendReminder, sendRSVPConfirmation } from "@/lib/email";
import { broadcastHtmlToText, renderBroadcastHtml, renderBroadcastTemplate, sampleBroadcastVariables } from "@/lib/broadcastTemplate";
import { broadcastBrandFor, broadcastEventUrl, broadcastTicketUrl, rsvpMatchesBroadcastAudience } from "@/lib/eventBroadcast";
import { isBroadcastDesign } from "@/lib/email/broadcastDesigns";
import { sendPasswordResetEmail } from "@/lib/email/passwordReset";
import { sendSignInCodeEmail } from "@/lib/email/signInCode";
import { sendEmailVerificationEmail } from "@/lib/email/emailVerification";
import { sendOperatorNotice } from "@/lib/email/operatorNotice";
import { describeOperationalError } from "@/lib/redactSensitiveText";
import { reportOpsAlert } from "@/lib/opsAlerts";
import { asMemberIdEmailPayload, deliverMemberIdCardEmail, MEMBER_ID_EMAIL_KIND } from "@/lib/memberIds/email";
import { asPaymentEmailPayload, deliverPaymentEmail, PAYMENT_EMAIL_KIND } from "@/lib/payments/email";
import { sendAs } from "@/lib/email/transporter";
import { asChatMessagePayload, deliverChatMessage } from "@/lib/chat/deliver";
import { CHAT_MESSAGE_KIND } from "@/lib/chat/notify";
import { EVENT_REMINDER_KIND, PermanentOutboxError, asCollaboratorInvitePayload, asEmailVerificationPayload, asEventBroadcastPayload, asEventBroadcastTestPayload, asEventInvitePayload, asEventReminderPayload, asOperatorNoticePayload, asPasswordResetPayload, asRsvpConfirmationPayload, asRsvpStatusPayload, asSignInCodePayload, containsCapability, isExpired, messageId, retryDelayMs } from "./payloads";
import { deliverTeamMessage, isTeamMessageKind } from "./team";
import { deliverJudgingMessage, isJudgingMessageKind } from "./judging";
import { attendeeName, broadcastEventSelect, broadcastVariablesFor, calendarEvent, getCurrentRsvp, messageOrganisation } from "./context";

/** Deliver a small batch. Run this from a protected scheduler, never a request path. */
export async function deliverOutboxBatch(limit = 20) {
  // A worker may be interrupted after claiming a message. Return a stale claim
  // to the retry queue before processing new work so messages cannot be lost.
  await prisma.outboxMessage.updateMany({
    where: {
      status: OutboxStatus.PROCESSING,
      lockedAt: { lt: new Date(Date.now() - 15 * 60_000) },
    },
    data: { status: OutboxStatus.PENDING, lockedAt: null },
  });

  const messages = await prisma.outboxMessage.findMany({
    where: { status: OutboxStatus.PENDING, availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
  });

  let sent = 0;
  let failed = 0;
  for (const message of messages) {
    const claimTime = new Date();
    const claim = await prisma.outboxMessage.updateMany({
      where: { id: message.id, status: OutboxStatus.PENDING },
      data: { status: OutboxStatus.PROCESSING, lockedAt: claimTime, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;

    try {
      // Everything sent for this message goes out as its organisation (or the platform).
      sendAs(await messageOrganisation(message.kind, message.payload).catch(() => null));
      const removeAfterDelivery = containsCapability(message.kind, message.payload);
      const stableMessageId = messageId(message.id);
      if (message.kind === "rsvp-confirmation") {
        const payload = asRsvpConfirmationPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        const rsvp = await getCurrentRsvp(payload.checkInToken);
        if (rsvp?.status !== payload.status) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
        await sendRSVPConfirmation({ ...payload, recipientName: attendeeName(rsvp), calendarEvent: calendarEvent(rsvp), messageId: stableMessageId });
      } else if (message.kind === "rsvp-status") {
        const payload = asRsvpStatusPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (payload.approved) {
          const rsvp = await getCurrentRsvp(payload.checkInToken!);
          if (rsvp?.status !== RsvpStatus.CONFIRMED) {
            await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
            continue;
          }
          await sendRSVPConfirmation({
            to: payload.to,
            eventTitle: payload.eventTitle,
            status: RsvpStatus.CONFIRMED,
            checkInToken: payload.checkInToken,
            recipientName: attendeeName(rsvp),
            calendarEvent: calendarEvent(rsvp),
            teamName: payload.teamName,
            messageId: stableMessageId,
          });
        } else {
          await sendApprovalNotification({ ...payload, messageId: stableMessageId });
        }
      } else if (message.kind === "sign-in-code") {
        const payload = asSignInCodePayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (isExpired(payload.expiresAt)) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          failed += 1;
          continue;
        }
        await sendSignInCodeEmail({ ...payload, messageId: stableMessageId });
      } else if (message.kind === "password-reset") {
        const payload = asPasswordResetPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (isExpired(payload.expiresAt)) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          failed += 1;
          continue;
        }
        await sendPasswordResetEmail({ ...payload, messageId: stableMessageId });
      } else if (message.kind === "email-verification") {
        const payload = asEmailVerificationPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (isExpired(payload.expiresAt)) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          failed += 1;
          continue;
        }
        await sendEmailVerificationEmail({ ...payload, messageId: stableMessageId });
      } else if (message.kind === "event-invite") {
        const payload = asEventInvitePayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (isExpired(payload.expiresAt)) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          failed += 1;
          continue;
        }
        await sendEventInvitation({ ...payload, messageId: stableMessageId });
      } else if (message.kind === "collaborator-invite") {
        const payload = asCollaboratorInvitePayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if (isExpired(payload.expiresAt)) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          failed += 1;
          continue;
        }
        await sendCollaboratorInvitation({ ...payload, messageId: stableMessageId });
      } else if (message.kind === "event-broadcast") {
        const payload = asEventBroadcastPayload(message.payload);
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
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
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
      } else if (message.kind === "event-broadcast-test") {
        const payload = asEventBroadcastTestPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        const event = await prisma.event.findUnique({ where: { id: payload.eventId }, select: broadcastEventSelect });
        if (!event) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
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
      } else if (message.kind === EVENT_REMINDER_KIND) {
        const payload = asEventReminderPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        const rsvp = await prisma.rSVP.findUnique({
          where: { id: payload.rsvpId },
          select: {
            status: true, checkInToken: true,
            event: { select: { title: true, startDateTime: true, timezone: true, location: true, isOnline: true, status: true } },
            eventInstance: { select: { startDateTime: true, cancelledAt: true, series: { select: { title: true, timezone: true, status: true } } } },
          },
        });
        const occasion = rsvp?.event
          ? { title: rsvp.event.title, start: rsvp.event.startDateTime, timezone: rsvp.event.timezone, location: rsvp.event.isOnline ? "Online" : rsvp.event.location, live: rsvp.event.status === "PUBLISHED" }
          : rsvp?.eventInstance
            ? { title: rsvp.eventInstance.series.title, start: rsvp.eventInstance.startDateTime, timezone: rsvp.eventInstance.series.timezone, location: undefined, live: rsvp.eventInstance.series.status === "PUBLISHED" && !rsvp.eventInstance.cancelledAt }
            : null;
        // Cancelled, moved into the past, or no longer confirmed: a reminder would be wrong.
        if (!rsvp || !occasion || rsvp.status !== RsvpStatus.CONFIRMED || !occasion.live || occasion.start <= new Date()) {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
        await sendReminder({
          to: payload.to,
          eventTitle: occasion.title,
          startsAtIso: occasion.start.toISOString(),
          timezone: occasion.timezone,
          location: occasion.location,
          ticketUrl: broadcastTicketUrl(rsvp.checkInToken),
          messageId: stableMessageId,
        });
      } else if (message.kind === CHAT_MESSAGE_KIND) {
        const payload = asChatMessagePayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        const outcome = await deliverChatMessage(payload);
        if (outcome === "permanent") throw new PermanentOutboxError();
        if (outcome === "dropped") {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
      } else if (message.kind === "operator-notice") {
        const payload = asOperatorNoticePayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        await sendOperatorNotice({ ...payload, messageId: stableMessageId });
      } else if (message.kind === MEMBER_ID_EMAIL_KIND) {
        const payload = asMemberIdEmailPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if ((await deliverMemberIdCardEmail(payload, stableMessageId)) === "dropped") {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
      } else if (message.kind === PAYMENT_EMAIL_KIND) {
        const payload = asPaymentEmailPayload(message.payload);
        if (!payload) throw new PermanentOutboxError();
        if ((await deliverPaymentEmail(payload, stableMessageId)) === "dropped") {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
      } else if (isTeamMessageKind(message.kind) || isJudgingMessageKind(message.kind)) {
        const outcome = isTeamMessageKind(message.kind)
          ? await deliverTeamMessage(message.kind, message.payload, stableMessageId)
          : await deliverJudgingMessage(message.kind, message.payload, stableMessageId);
        if (!outcome) throw new PermanentOutboxError();
        if (outcome === "dropped") {
          await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
          continue;
        }
      } else {
        throw new PermanentOutboxError();
      }
      if (removeAfterDelivery) {
        await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
      } else {
        await prisma.outboxMessage.updateMany({
          where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime },
          data: { status: OutboxStatus.SENT, sentAt: new Date(), lockedAt: null, lastError: null },
        });
      }
      sent += 1;
    } catch (error) {
      const attempts = message.attempts + 1;
      const retryAt = new Date(Date.now() + retryDelayMs(message.kind, attempts));
      const terminal = error instanceof PermanentOutboxError || attempts >= 8;
      if (containsCapability(message.kind, message.payload) && terminal) {
        await prisma.outboxMessage.deleteMany({ where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime } });
      } else {
        await prisma.outboxMessage.updateMany({
          where: { id: message.id, status: OutboxStatus.PROCESSING, lockedAt: claimTime },
          data: {
            status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
            availableAt: retryAt,
            lockedAt: null,
            lastError: describeOperationalError(error),
          },
        });
      }
      reportOpsAlert({
        level: terminal ? "error" : "warning",
        source: "email",
        title: terminal ? "Email delivery failed permanently" : "Email delivery failed; will retry",
        error,
        context: { kind: message.kind, attempt: attempts },
      });
      failed += 1;
    }
  }
  sendAs(null);
  return { sent, failed };
}
