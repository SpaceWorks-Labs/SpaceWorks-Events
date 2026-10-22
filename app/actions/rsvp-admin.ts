"use server";

import { Prisma, RsvpStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { deleteRsvpSchema, manualRsvpSchema, restoreRsvpSchema, updateRsvpRegistrationSchema } from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { submitManualGuestRsvpCore } from "@/lib/rsvpCore";
import { validateAndNormalizeAnswers } from "@/lib/rsvpCore";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { hasCapacityToRestoreConfirmedRsvp } from "@/lib/rsvpCapacity";
import { noticeSubject, personEmail } from "@/lib/notices";
import { enqueueRsvpConfirmation } from "@/lib/outbox";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { restoreListCheckIns, revalidatePath, revalidateRsvpPaths, snapshotSchema, UNDO_TTL_MS } from "./rsvp-admin/helpers";

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
      event: { select: { slug: true, title: true, endDateTime: true } },
      eventInstance: { select: { endDateTime: true, series: { select: { title: true } } } },
      order: { select: { totalMinor: true } },
      checkInListRecords: { select: { listId: true, checkedInAt: true, source: true } },
    },
  });
  if (!rsvp) return { ok: false, error: "RSVP not found." };
  // Paid tickets keep their money trail: they're cancelled (and refunded) as an order.
  if (rsvp.order && rsvp.order.totalMinor > BigInt(0)) return { ok: false, error: "This ticket was part of a paid order. Use Payment → Cancel tickets instead." };

  const snapshot = {
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

  const undo = await prisma.$transaction(async (tx) => {
    // Keep the short-lived undo table bounded even when no scheduled cleanup is
    // configured. Expired snapshots are never eligible for restoration.
    await tx.rsvpDeletionUndo.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    const created = await tx.rsvpDeletionUndo.create({
      data: {
        organisationId: org.id,
        deletedByUserId: session.user.id,
        payload: snapshot as Prisma.InputJsonValue,
        expiresAt: new Date(Date.now() + UNDO_TTL_MS),
      },
      select: { id: true },
    });
    await tx.rSVP.delete({ where: { id: rsvp.id } });
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
  await recordAuditEvent({ action: "RSVP_DELETED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: rsvp.id });

  revalidateRsvpPaths(org.slug, { eventId: rsvp.eventId, eventInstanceId: rsvp.eventInstanceId, eventSlug: rsvp.event?.slug });
  return { ok: true, data: { undoId: undo.id } };
}

/** Restore only a short-lived snapshot created by this server for this organiser. */
export async function restoreRsvp(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("rsvp", session.user.id)) return { ok: false, error: "Too many attendee updates. Try again shortly." };
  const parsed = restoreRsvpSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid restore request." };

  const org = await prisma.organisation.findUnique({ where: { slug: parsed.data.organisationSlug } });
  if (!org) return { ok: false, error: "Organisation not found." };

  const undo = await prisma.rsvpDeletionUndo.findFirst({
    where: {
      id: parsed.data.undoId,
      organisationId: org.id,
      deletedByUserId: session.user.id,
      expiresAt: { gt: new Date() },
    },
  });
  if (!undo) return { ok: false, error: "This undo has expired or is unavailable." };
  const snapshot = snapshotSchema.safeParse(undo.payload);
  if (!snapshot.success) return { ok: false, error: "Could not restore this RSVP safely." };
  // Re-checked against the snapshot's own event or occurrence: the undo row is
  // the deleter's, but their access may have changed since.
  if (!(await canManageRegistrationsFor({ userId: session.user.id, organisationId: org.id, eventId: snapshot.data.eventId, eventInstanceId: snapshot.data.eventInstanceId }))) {
    return { ok: false, error: "You do not have permission to restore RSVPs." };
  }

  const targetExists = snapshot.data.eventId
    ? await prisma.event.findFirst({ where: { id: snapshot.data.eventId, organisationId: org.id }, select: { id: true, slug: true } })
    : await prisma.eventInstance.findFirst({ where: { id: snapshot.data.eventInstanceId!, series: { organisationId: org.id } }, select: { id: true } });
  if (!targetExists) return { ok: false, error: "The original event no longer exists." };

  let restoredId: string;
  try {
    const restored = await prisma.$transaction(async (tx) => {
      if (snapshot.data.status === RsvpStatus.CONFIRMED) {
        const target = snapshot.data.eventId ? { eventId: snapshot.data.eventId } : { eventInstanceId: snapshot.data.eventInstanceId! };
        if (!(await hasCapacityToRestoreConfirmedRsvp(tx, target))) return null;
      }
      const created = await tx.rSVP.create({
        data: {
          eventId: snapshot.data.eventId,
          eventInstanceId: snapshot.data.eventInstanceId,
          userId: snapshot.data.userId,
          guestEmail: snapshot.data.guestEmail,
          guestName: snapshot.data.guestName,
          status: snapshot.data.status,
          attendeeKey: snapshot.data.attendeeKey,
          checkInToken: snapshot.data.checkInToken,
          checkedInAt: snapshot.data.checkedInAt ? new Date(snapshot.data.checkedInAt) : null,
          createdAt: new Date(snapshot.data.createdAt),
          answers: {
            create: snapshot.data.answers.map((answer) => ({
              fieldId: answer.fieldId,
              valueText: answer.valueText,
              valueBool: answer.valueBool,
              valueNumber: answer.valueNumber,
              valueDate: answer.valueDate ? new Date(answer.valueDate) : null,
            }))
          },
        },
      });
      await restoreListCheckIns(tx, snapshot.data.eventId, created.id, snapshot.data.listCheckIns);
      await tx.rsvpDeletionUndo.delete({ where: { id: undo.id } });
      // The removal notice waiting out the undo window is no longer true.
      await tx.outboxMessage.deleteMany({ where: { kind: "operator-notice", status: "PENDING", payload: { path: ["undoId"], equals: undo.id } } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!restored) return { ok: false, error: "This RSVP cannot be restored because the event is now at capacity." };
    restoredId = restored.id;
    emitWebhookEvent({ type: "registration.status_changed", rsvpId: restored.id, status: restored.status, previousStatus: "REMOVED" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string; }).code === "P2002") {
      return { ok: false, error: "This RSVP can no longer be restored because a conflicting registration exists." };
    }
    console.error("[rsvp] restore failed");
    return { ok: false, error: "Could not restore the RSVP." };
  }

  const eventSlug = snapshot.data.eventId && "slug" in targetExists
    ? String(targetExists.slug)
    : undefined;
  revalidateRsvpPaths(org.slug, {
    eventId: snapshot.data.eventId,
    eventInstanceId: snapshot.data.eventInstanceId,
    eventSlug,
  });
  await recordAuditEvent({ action: "RSVP_RESTORED", actorUserId: session.user.id, organisationId: org.id, targetType: "RSVP", targetId: restoredId });
  return { ok: true };
}
