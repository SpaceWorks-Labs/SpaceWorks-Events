import { Prisma, RsvpStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canManageRegistrationsFor } from "@/lib/eventAccess";
import { restoreRsvpSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { hasCapacityToRestoreConfirmedRsvp } from "@/lib/rsvpCapacity";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { restoreListCheckIns, revalidateRsvpPaths, snapshotSchema, teamForRestore } from "./helpers";
import { isTeamDeletionSnapshot, restoreTeamDeletionSnapshot } from "@/lib/core/teams";
import { restoreSubmissionSnapshotTx } from "@/lib/core/submissionLifecycle";

const ADMISSION_NO_RESTORE = "This event takes applications: a removed application stays withdrawn and can't be restored.";

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
  if (isTeamDeletionSnapshot(undo.payload)) {
    const teamEventId = (undo.payload as { eventId?: unknown }).eventId;
    if (typeof teamEventId !== "string" || !teamEventId) return { ok: false, error: "Could not restore the team." };
    // As for a single RSVP: the deleter's access may have changed since.
    if (!(await canManageRegistrationsFor({ userId: session.user.id, organisationId: org.id, eventId: teamEventId }))) {
      return { ok: false, error: "You do not have permission to restore RSVPs." };
    }
    if (await prisma.event.count({ where: { id: teamEventId, admissionEnabled: true } })) return { ok: false, error: ADMISSION_NO_RESTORE };
    const restoredTeam = await restoreTeamDeletionSnapshot(undo, org.id);
    if (!restoredTeam.ok || !restoredTeam.data) return restoredTeam.ok ? { ok: false, error: "Could not restore the team." } : restoredTeam;
    revalidateRsvpPaths(org.slug, { eventId: restoredTeam.data.eventId, eventInstanceId: null, eventSlug: restoredTeam.data.eventSlug });
    await recordAuditEvent({ action: "TEAM_RESTORED", actorUserId: session.user.id, organisationId: org.id, targetType: "Team", targetId: restoredTeam.data.teamId });
    return { ok: true };
  }
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
  // Applications (docs/ADMISSION.md): a removed applicant's application is kept as withdrawn and isn't restored.
  if (snapshot.data.eventId && (await prisma.event.count({ where: { id: snapshot.data.eventId, admissionEnabled: true } }))) return { ok: false, error: ADMISSION_NO_RESTORE };

  let restoredId: string;
  let refusal = "This RSVP cannot be restored because the event is now at capacity.";
  try {
    const restored = await prisma.$transaction(async (tx) => {
      let status = snapshot.data.status;
      let teamId: string | null = null;
      if (snapshot.data.teamId && snapshot.data.eventId) {
        const team = await teamForRestore(tx, { eventId: snapshot.data.eventId, teamId: snapshot.data.teamId });
        if (!team) { refusal = "This RSVP cannot be restored because its team no longer exists or is full."; return null; }
        status = team.status;
        teamId = team.id;
      } else if (snapshot.data.status === RsvpStatus.CONFIRMED) {
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
          status,
          ...(teamId ? { teamId } : {}),
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
      if (snapshot.data.submission && snapshot.data.eventId && !teamId) {
        await restoreSubmissionSnapshotTx(tx, snapshot.data.submission, { eventId: snapshot.data.eventId, rsvpId: created.id });
      }
      await tx.rsvpDeletionUndo.delete({ where: { id: undo.id } });
      // The removal notice waiting out the undo window is no longer true.
      await tx.outboxMessage.deleteMany({ where: { kind: "operator-notice", status: "PENDING", payload: { path: ["undoId"], equals: undo.id } } });
      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    if (!restored) return { ok: false, error: refusal };
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
