"use server";

import { Prisma, RsvpStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { deleteRsvpSchema, manualRsvpSchema, updateRsvpRegistrationSchema } from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { submitManualGuestRsvpCore } from "@/lib/rsvpCore";
import { validateAndNormalizeAnswers } from "@/lib/rsvpCore";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { noticeSubject, personEmail } from "@/lib/notices";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { revalidatePath, revalidateRsvpPaths, settleTeamAfterRemoval, teamDeletionPayload, UNDO_TTL_MS } from "./rsvp-admin/helpers";
import { restoreRsvp as restoreRsvpAction } from "./rsvp-admin/restore";
import { captureSubmissionSnapshotTx, type SubmissionSnapshot } from "@/lib/core/submissionLifecycle";
import { emitTeamWebhooks, type RegistrationStatusWebhook } from "@/lib/teamUnits";

export async function addManualRsvp(
  input: unknown,
): Promise<ActionResult<{ count: number; status: RsvpStatus; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("rsvp", session.user.id)) {
    return { ok: false, error: "Too many attendee additions. Please try again shortly." };
  }
  const parsed = manualRsvpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  }

  const org = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug } });
  if (!org) return { ok: false, error: "Organisation not found." };
  if (!(await canManageRegistrationsFor({ userId: session.user.id, organisationId: org.id, eventId: parsed.data.eventId }))) {
    return { ok: false, error: "You do not have permission to add attendees." };
  }

  const result = await submitManualGuestRsvpCore(parsed.data, { organisationId: org.id });
  if (!result.ok || !result.data) return result;

  await recordAuditEvent({
    action: "MANUAL_RSVP_CREATED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "RSVP",
    targetId: result.data.rsvpId,
    metadata: { eventId: parsed.data.eventId, status: result.data.status },
  });
  revalidateRsvpPaths(org.slug, { eventId: parsed.data.eventId, eventInstanceId: null });
  revalidatePath(`/dashboard/${org.slug}/event/${parsed.data.eventId}/check-in`);
  return { ok: true, data: { count: result.data.count, status: result.data.status } };
}

export async function updateRsvpRegistration(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("rsvp", session.user.id)) {
    return { ok: false, error: "Too many attendee edits. Please try again shortly." };
  }
  const parsed = updateRsvpRegistrationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };

  const org = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug } });
  if (!org) return { ok: false, error: "Organisation not found." };
  if (!(await canManageRegistrationsFor({ userId: session.user.id, organisationId: org.id, eventId: parsed.data.eventId, eventInstanceId: parsed.data.eventInstanceId }))) {
    return { ok: false, error: "You do not have permission to edit registrations." };
  }

  const target = parsed.data.eventId
    ? { eventId: parsed.data.eventId, event: { organisationId: org.id } }
    : { eventInstanceId: parsed.data.eventInstanceId, eventInstance: { series: { organisationId: org.id } } };
  const rsvp = await prisma.rSVP.findFirst({
    where: { id: parsed.data.rsvpId, ...target },
    include: {
      user: { select: { id: true } },
      event: { select: { slug: true, title: true, registrationForm: { include: { fields: { orderBy: { sortOrder: "asc" } } } } } },
      eventInstance: { select: { series: { select: { title: true } } } },
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };

  const formFields = rsvp.event?.registrationForm?.fields ?? [];
  const validated = validateAndNormalizeAnswers({
    fields: formFields.map((field) => ({ ...field, options: field.options })),
    answers: parsed.data.answers as Record<string, unknown>,
  });
  if ("error" in validated) return { ok: false, error: validated.error };

  const guestUpdate = rsvp.userId ? {} : {
    guestName: parsed.data.name?.trim() || rsvp.guestName,
    guestEmail: parsed.data.guestEmail?.trim().toLowerCase() || rsvp.guestEmail,
  };
  const guestEmail = "guestEmail" in guestUpdate ? guestUpdate.guestEmail : rsvp.guestEmail;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.rSVP.update({
        where: { id: rsvp.id },
        data: {
          ...guestUpdate,
          ...(rsvp.userId ? {} : { attendeeKey: `guest:${guestEmail}` }),
        },
      });
      const title = rsvp.event?.title ?? rsvp.eventInstance?.series.title;
      const live = rsvp.status === RsvpStatus.CONFIRMED || rsvp.status === RsvpStatus.WAITLISTED || rsvp.status === RsvpStatus.PENDING_APPROVAL;
      if (guestEmail && guestEmail !== rsvp.guestEmail && title && live) {
        await enqueueRsvpConfirmation(tx, { to: guestEmail, eventTitle: title, status: rsvp.status, checkInToken: rsvp.checkInToken });
      }
      await tx.rsvpAnswer.deleteMany({ where: { rsvpId: rsvp.id } });
      if (validated.rows.length > 0) {
        await tx.rsvpAnswer.createMany({
          data: validated.rows.map((row) => ({
            rsvpId: rsvp.id,
            fieldId: row.fieldId,
            valueText: row.valueText ?? null,
            valueBool: row.valueBool ?? null,
            valueNumber: row.valueNumber ?? null,
            valueDate: row.valueDate ?? null,
          })),
        });
      }
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string; }).code === "P2002") {
      return { ok: false, error: "This email is already registered for this event." };
    }
    console.error("[rsvp] registration update failed");
    return { ok: false, error: "Could not update the registration." };
  }

  await recordAuditEvent({ action: "RSVP_REGISTRATION_UPDATED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });
  revalidateRsvpPaths(org.slug, { eventId: rsvp.eventId, eventInstanceId: rsvp.eventInstanceId, eventSlug: rsvp.event?.slug });
  return { ok: true };
}

export async function deleteRsvp(input: unknown): Promise<ActionResult<{ undoId: string; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("rsvp", session.user.id)) return { ok: false, error: "Too many attendee updates. Try again shortly." };

  const parsed = deleteRsvpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid input.", fieldErrors: flattenZodErrors(parsed.error) };
  }

  const { organisationSlug, eventId, eventInstanceId, rsvpId } = parsed.data;
  const org = await prisma.organisation.findUnique({ where: { slug: organisationSlug } });
  if (!org) return { ok: false, error: "Organisation not found." };
  if (!(await canManageRegistrationsFor({ userId: session.user.id, organisationId: org.id, eventId, eventInstanceId }))) {
    return { ok: false, error: "You do not have permission to manage attendees." };
  }

  const rsvp = await prisma.rSVP.findFirst({
    where: {
      id: rsvpId,
      ...(eventId ? { eventId, event: { organisationId: org.id } } : { eventInstanceId, eventInstance: { series: { organisationId: org.id } } }),
    },
    include: {
      answers: true,
      user: { select: { email: true } },
      event: { select: { slug: true, title: true, endDateTime: true, registrationMode: true } },
      eventInstance: { select: { endDateTime: true, series: { select: { title: true } } } },
      order: { select: { totalMinor: true } },
      checkInListRecords: { select: { listId: true, checkedInAt: true, source: true } },
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };
  // Paid tickets keep their money trail: they're cancelled (and refunded) as an order.
  if (rsvp.order && rsvp.order.totalMinor > BigInt(0)) return { ok: false, error: "This ticket was part of a paid order. Use Payment → Cancel tickets instead." };

  const teamEvent = rsvp.eventId && rsvp.event?.registrationMode === "TEAM" ? rsvp.eventId : null;
  const snapshot: Record<string, unknown> & { teamId?: string | null; submission?: SubmissionSnapshot | null; } = {
    ...(teamEvent ? { teamId: rsvp.teamId } : {}),
    eventId: rsvp.eventId,
    eventInstanceId: rsvp.eventInstanceId,
    userId: rsvp.userId,
    guestEmail: rsvp.guestEmail,
    guestName: rsvp.guestName,
    status: rsvp.status,
    attendeeKey: rsvp.attendeeKey,
    checkInToken: rsvp.checkInToken,
    checkedInAt: rsvp.checkedInAt?.toISOString() ?? null,
    createdAt: rsvp.createdAt.toISOString(),
    answers: rsvp.answers.map((answer) => ({
      fieldId: answer.fieldId,
      valueText: answer.valueText,
      valueBool: answer.valueBool,
      valueNumber: answer.valueNumber,
      valueDate: answer.valueDate?.toISOString() ?? null,
    })),
    listCheckIns: rsvp.checkInListRecords.map((record) => ({
      listId: record.listId,
      checkedInAt: record.checkedInAt.toISOString(),
      source: record.source,
    })),
  };

  const promotedWebhooks: RegistrationStatusWebhook[] = [];
  const undo = await prisma.$transaction(async (tx) => {
    const team = teamEvent ? await teamDeletionPayload(tx, { eventId: teamEvent, rsvpId: rsvp.id, snapshot }) : null;
    // Same lock order as entrant submission writes (Event, then RSVP).
    if (!teamEvent && rsvp.eventId) await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${rsvp.eventId} FOR UPDATE`;
    // A solo registration's project (and its scores) cascades with the RSVP;
    // keep it in the undo snapshot so restoring brings it back.
    let payload = team?.payload ?? (snapshot as Prisma.InputJsonValue);
    if (rsvp.eventId && !team?.teamId) {
      snapshot.submission = await captureSubmissionSnapshotTx(tx, { eventId: rsvp.eventId, rsvpId: rsvp.id });
      payload = snapshot as Prisma.InputJsonValue;
    }
    // Keep the short-lived undo table bounded even when no scheduled cleanup is
    // configured. Expired snapshots are never eligible for restoration.
    await tx.rsvpDeletionUndo.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const created = await tx.rsvpDeletionUndo.create({
      data: {
        organisationId: org.id,
        deletedByUserId: session.user.id,
        payload,
        expiresAt: new Date(Date.now() + UNDO_TTL_MS),
      },
      select: { id: true },
    });
    await tx.rSVP.delete({ where: { id: rsvp.id } });
    if (teamEvent && team?.teamId) promotedWebhooks.push(...await settleTeamAfterRemoval(tx, { eventId: teamEvent, teamId: team.teamId, rsvpId: rsvp.id }));
    return created;
  });
  // The guest is told once the undo window has passed, unless the removal was undone.
  const to = rsvp.status === RsvpStatus.CONFIRMED || rsvp.status === RsvpStatus.WAITLISTED || rsvp.status === RsvpStatus.PENDING_APPROVAL ? personEmail(rsvp) : null;
  const title = rsvp.event?.title ?? rsvp.eventInstance?.series.title;
  if (to && title && (rsvp.event ? rsvp.event.endDateTime > new Date() : (rsvp.eventInstance?.endDateTime ?? new Date(0)) > new Date())) {
    await prisma.outboxMessage.create({
      data: {
        kind: "operator-notice",
        availableAt: new Date(Date.now() + UNDO_TTL_MS),
        payload: { to, organisationId: org.id, subject: noticeSubject("Registration removed", title), lines: [`The organiser removed your registration for ${title}, so your ticket no longer works.`, "If you think this is a mistake, reply to the organiser's emails or contact them directly."], undoId: undo.id },
      },
    });
  }

  emitWebhookEvent({
    type: "registration.status_changed",
    rsvpId: rsvp.id,
    status: "REMOVED",
    previousStatus: rsvp.status,
    snapshot: { id: rsvp.id, eventId: rsvp.eventId, eventInstanceId: rsvp.eventInstanceId, userId: rsvp.userId, guestName: rsvp.guestName, createdAt: rsvp.createdAt, checkedInAt: rsvp.checkedInAt },
  });
  emitTeamWebhooks(promotedWebhooks);
  await recordAuditEvent({ action: "RSVP_DELETED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });

  revalidateRsvpPaths(org.slug, { eventId: rsvp.eventId, eventInstanceId: rsvp.eventInstanceId, eventSlug: rsvp.event?.slug });
  return { ok: true, data: { undoId: undo.id } };
}

/** Restore only a short-lived snapshot created by this server for this organiser. */
export async function restoreRsvp(input: unknown): Promise<ActionResult> {
  return restoreRsvpAction(input);
}
