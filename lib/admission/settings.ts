import "server-only";

import { AdmissionMode, AdmissionStageStatus, EventPrivacyType, RegistrationMode, TeamTicketMode, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { AdmissionContext } from "./access";
import { PER_MEMBER_PAID_REFUSAL } from "./rules";

export { PER_MEMBER_PAID_REFUSAL };

/*
 * Turning applications on and off, and the admission settings
 * (docs/ADMISSION.md "Setting up"). Any one-off event can take applications:
 * a conference, a workshop or a hackathon, solo or team registration, free
 * or paid. Recurring series can't (their registrations are per date).
 *
 * - On or off only while the event has no registrations (crew aside), so
 *   every registration of an admission event is an application and none is.
 * - On makes the event approval-required (a CHECK keeps it so) and adds a
 *   first stage, "Review", when there is none.
 * - Paid places on a team event are paid once by the team leader (PER_TEAM).
 *   Paying per member is not supported with applications yet.
 */

export const HAS_REGISTRATIONS_REFUSAL = "Applications can only be turned on or off before anyone has registered.";

export type AdmissionSettingsInput = { mode: AdmissionMode; rsvpDays: number; offerCapacity: number | null; emailOnStageAdvance: boolean };

type Result = { ok: true } | { ok: false; error: string };

async function hasPaidTickets(tx: Prisma.TransactionClient, eventId: string): Promise<boolean> {
  return (await tx.ticketType.count({ where: { eventId, archivedAt: null, OR: [{ priceMinor: { gt: 0 } }, { pricing: "FLEXIBLE" }] } })) > 0;
}

/** Why paid admission can't work on this event as set up, or null. */
export async function perMemberRefusal(tx: Prisma.TransactionClient, event: { id: string; registrationMode: RegistrationMode; teamTicketMode: TeamTicketMode }): Promise<string | null> {
  if (event.registrationMode !== RegistrationMode.TEAM || event.teamTicketMode !== TeamTicketMode.PER_MEMBER) return null;
  return (await hasPaidTickets(tx, event.id)) ? PER_MEMBER_PAID_REFUSAL : null;
}

/** For the Settings card: whether applications can be turned on now, and why not. */
export async function admissionEnableState(eventId: string): Promise<{ canEnable: boolean; reason: string | null }> {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, registrationMode: true, teamTicketMode: true } });
  if (!event) return { canEnable: false, reason: null };
  if ((await prisma.rSVP.count({ where: { eventId, isCrew: false } })) > 0) return { canEnable: false, reason: HAS_REGISTRATIONS_REFUSAL };
  const refusal = await perMemberRefusal(prisma, event);
  return refusal ? { canEnable: false, reason: refusal } : { canEnable: true, reason: null };
}

export async function setAdmissionEnabled(ctx: AdmissionContext, enabled: boolean): Promise<Result> {
  if (!ctx.isAdmin) return { ok: false, error: "Only organisation owners and admins can turn applications on or off." };
  const result = await prisma.$transaction(async (tx): Promise<Result> => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.eventId} FOR UPDATE`;
    const event = await tx.event.findFirst({ where: { id: ctx.eventId, organisationId: ctx.organisationId }, select: { id: true, admissionEnabled: true, registrationMode: true, teamTicketMode: true, privacyType: true } });
    if (!event) return { ok: false, error: "Event not found." };
    if (event.admissionEnabled === enabled) return { ok: true };
    if ((await tx.rSVP.count({ where: { eventId: event.id, isCrew: false } })) > 0) return { ok: false, error: HAS_REGISTRATIONS_REFUSAL };
    if (enabled) {
      const refusal = await perMemberRefusal(tx, event);
      if (refusal) return { ok: false, error: refusal };
      await tx.event.update({ where: { id: event.id }, data: { admissionEnabled: true, privacyType: EventPrivacyType.APPROVAL_REQUIRED } });
      if ((await tx.admissionStage.count({ where: { eventId: event.id } })) === 0) {
        await tx.admissionStage.create({ data: { eventId: event.id, position: 1, name: "Review", status: AdmissionStageStatus.OPEN } });
      }
    } else {
      await tx.event.update({ where: { id: event.id }, data: { admissionEnabled: false } });
    }
    await recordAuditEvent({ client: tx, action: enabled ? "ADMISSION_ENABLED" : "ADMISSION_DISABLED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: event.id, metadata: { previousPrivacy: event.privacyType } });
    return { ok: true };
  });
  return result;
}

export async function updateAdmissionSettings(ctx: AdmissionContext, input: AdmissionSettingsInput): Promise<Result> {
  if (!ctx.isAdmin) return { ok: false, error: "Only organisation owners and admins can change application settings." };
  const updated = await prisma.event.updateMany({
    where: { id: ctx.eventId, organisationId: ctx.organisationId, admissionEnabled: true },
    data: { admissionMode: input.mode, admissionRsvpDays: input.rsvpDays, admissionOfferCapacity: input.offerCapacity, emailApplicantsOnStageAdvance: input.emailOnStageAdvance },
  });
  if (updated.count !== 1) return { ok: false, error: "Turn applications on first." };
  await recordAuditEvent({ action: "ADMISSION_SETTINGS_UPDATED", actorUserId: ctx.userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { mode: input.mode, rsvpDays: input.rsvpDays, offerCapacity: input.offerCapacity, emailOnStageAdvance: input.emailOnStageAdvance } });
  return { ok: true };
}
