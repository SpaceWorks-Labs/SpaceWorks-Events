import "server-only";

import { AdmissionStatus, RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { enqueueRsvpStatusNotification } from "@/lib/outbox";
import { onlineAccount, PaymentOperationError } from "@/lib/payments/operations/shared";
import type { WebhookEmission } from "@/lib/webhooks/emit";
import type { AdmissionContext } from "./access";
import { applicationChanged, emitAll } from "./notify";
import { holdPaidPlace } from "./payment";
import { promoteWaitlisted } from "./promotion";
import { extensionRefusal } from "./rules";
import { AdmissionError, applicationSelect, isPaid, lockAdmissionEvent, personEmailOf, placesTaken, setUnitStatus, ticketTypeHasRoom, unitMembers, unitOrder, updateApplication } from "./state";
import { closeApplication } from "./transitions";
import { queueNotice } from "./notify";

/*
 * Answering an offer (docs/ADMISSION.md "Offers"): the applicant from their
 * ticket page (the ticket token is the bearer), or an organiser on their
 * behalf. On a team application only the leader answers.
 *
 * - Accept, free place: confirmed at once (capacity checked under the Event
 *   lock) with the usual ticket email.
 * - Accept, paid place: the place is held while the order is paid (see
 *   payment.ts); the payment confirms it. Never confirmed unpaid.
 * - Decline (an offer) or withdraw (in review, waitlisted or offered): closed
 *   for good, any unpaid order cancelled, and the next waitlisted application
 *   is offered the place.
 */

export type RespondAction = "accept" | "decline" | "withdraw";
export type RespondResult = { ok: true; status: AdmissionStatus; paying: boolean } | { ok: false; error: string };

const fail = (error: string): RespondResult => ({ ok: false, error });

/** The applicant's own answer, found by their ticket token. */
export async function respondAsApplicant(token: string, action: RespondAction, now = new Date()): Promise<RespondResult> {
  const rsvp = await prisma.rSVP.findUnique({ where: { checkInToken: token }, select: { id: true, eventId: true, teamId: true, isCrew: true, team: { select: { leaderRsvpId: true } } } });
  if (!rsvp?.eventId || rsvp.isCrew) return fail("This ticket has no application.");
  const app = await prisma.admissionApplication.findFirst({ where: rsvp.teamId ? { teamId: rsvp.teamId } : { rsvpId: rsvp.id }, select: { id: true } });
  if (!app) return fail("This ticket has no application.");
  if (rsvp.teamId && rsvp.team?.leaderRsvpId !== rsvp.id) return fail("Only the team leader can answer for the team.");
  return respond(rsvp.eventId, app.id, action, null, now);
}

/** An organiser answers for the applicant (they asked by email, say). Audited. */
export async function respondForApplicant(ctx: AdmissionContext, applicationId: string, action: RespondAction, now = new Date()): Promise<RespondResult> {
  const result = await respond(ctx.eventId, applicationId, action, ctx.userId, now, ctx.organisationId);
  if (result.ok) await recordAuditEvent({ action: "ADMISSION_RESPONDED_FOR_APPLICANT", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { applicationId, response: action } });
  return result;
}

async function respond(eventId: string, applicationId: string, action: RespondAction, actorUserId: string | null, now: Date, organisationId?: string): Promise<RespondResult> {
  // A paid acceptance needs the organisation's payment account (read before the transaction).
  let account: Awaited<ReturnType<typeof onlineAccount>> | null = null;
  if (action === "accept") {
    const app = await prisma.admissionApplication.findFirst({ where: { id: applicationId, eventId }, select: { rsvpId: true, teamId: true, event: { select: { organisationId: true } } } });
    if (!app) return fail("Application not found.");
    if (isPaid(await unitOrder(prisma, app))) {
      try {
        account = await onlineAccount(app.event.organisationId);
      } catch (error) {
        return fail(error instanceof PaymentOperationError ? error.message : "Payments aren't available right now.");
      }
    }
  }
  const webhooks: WebhookEmission[] = [];
  let promote = false;
  try {
    const result = await prisma.$transaction(async (tx): Promise<RespondResult> => {
      const event = await lockAdmissionEvent(tx, eventId, organisationId);
      if (!event?.admissionEnabled) return fail("Applications are closed for this event.");
      const app = await tx.admissionApplication.findFirst({ where: { id: applicationId, eventId }, select: applicationSelect });
      if (!app) return fail("Application not found.");
      const members = await unitMembers(tx, app);
      const paying = members.some((member) => member.status === RsvpStatus.PENDING_PAYMENT && member.holdExpiresAt && member.holdExpiresAt > now);
      if (action === "accept") {
        if (app.status === AdmissionStatus.ACCEPTED) return { ok: true, status: app.status, paying: false };
        if (app.status !== AdmissionStatus.OFFERED) return fail("There's no offer to accept.");
        if (!app.respondBy || app.respondBy <= now) return fail("This offer has ended.");
        if (paying) return { ok: true, status: app.status, paying: true };
        if (account) {
          await holdPaidPlace(tx, { event, app, account, actorUserId, now });
          return { ok: true, status: app.status, paying: true };
        }
        if (event.capacity != null && (await placesTaken(tx, event, now)) >= event.capacity) return fail("There are no free places right now. Try again a little later.");
        if (!(await ticketTypeHasRoom(tx, members[0]?.ticketTypeId ?? null, event.id, now))) return fail("This ticket type has no free places right now. Try again a little later.");
        await updateApplication(tx, app, { status: AdmissionStatus.ACCEPTED, skipReason: null });
        webhooks.push(...(await setUnitStatus(tx, app, RsvpStatus.CONFIRMED)), applicationChanged(app.id, app.status, AdmissionStatus.ACCEPTED));
        const team = app.teamId ? await tx.team.findUnique({ where: { id: app.teamId }, select: { name: true } }) : null;
        for (const member of members) {
          const to = personEmailOf(member);
          if (to) await enqueueRsvpStatusNotification(tx, { to, organisationId: event.organisationId, eventTitle: event.title, approved: true, checkInToken: member.checkInToken, ...(team ? { teamName: team.name } : {}) });
        }
        return { ok: true, status: AdmissionStatus.ACCEPTED, paying: false };
      }
      if (paying) return fail("A payment for this place is in progress. Try again once it has finished or its hold has ended.");
      if (action === "decline" && app.status !== AdmissionStatus.OFFERED) return fail("There's no offer to decline.");
      if (action === "withdraw" && app.status === AdmissionStatus.ACCEPTED) return fail("You already have a place. Cancel your ticket instead.");
      if (action === "withdraw" && !([AdmissionStatus.IN_REVIEW, AdmissionStatus.WAITLISTED, AdmissionStatus.OFFERED] as AdmissionStatus[]).includes(app.status)) return fail("This application is already closed.");
      promote = app.status === AdmissionStatus.OFFERED;
      const to = action === "decline" ? AdmissionStatus.DECLINED : AdmissionStatus.WITHDRAWN;
      webhooks.push(...(await closeApplication({ tx, event, app, now }, to)));
      return { ok: true, status: to, paying: false };
    }, { timeout: 20_000, maxWait: 10_000 });
    emitAll(webhooks);
    if (result.ok && promote) await promoteWaitlisted(eventId, now).catch(() => 0);
    return result;
  } catch (error) {
    if (error instanceof AdmissionError || error instanceof PaymentOperationError) return fail(error.message);
    throw error;
  }
}

/** Give an applicant more time to answer an offer. Audited; the applicant is emailed. */
export async function extendOffer(ctx: AdmissionContext, applicationId: string, respondBy: Date, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const event = await lockAdmissionEvent(tx, ctx.eventId, ctx.organisationId);
      if (!event) return { ok: false as const, error: "Event not found." };
      const app = await tx.admissionApplication.findFirst({ where: { id: applicationId, eventId: event.id }, select: applicationSelect });
      if (!app || app.status !== AdmissionStatus.OFFERED) return { ok: false as const, error: "Only an open offer can be extended." };
      const refusal = extensionRefusal(now, app.respondBy, respondBy, event.startDateTime);
      if (refusal) return { ok: false as const, error: refusal };
      await updateApplication(tx, app, { respondBy, offerReminderSentAt: null });
      await queueNotice(tx, event.organisationId, app, "extended", app.decisionRevision);
      await recordAuditEvent({ client: tx, action: "ADMISSION_OFFER_EXTENDED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: event.id, metadata: { applicationId } });
      return { ok: true as const };
    });
  } catch (error) {
    if (error instanceof AdmissionError) return { ok: false, error: error.message };
    throw error;
  }
}
