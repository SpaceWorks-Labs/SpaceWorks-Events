import { z } from "zod";
import { prisma } from "@/lib/db";
import { restoreRsvpForUser } from "@/lib/core/rsvpAdmin";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";

const bodySchema = z.object({ undoId: z.string().min(1).max(128) }).strict();

export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/guests/restore", null, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  // The undo must belong to this caller, organisation and the event in the path.
  const undo = await prisma.rsvpDeletionUndo.findFirst({
    where: { id: body.data.undoId, organisationId: event.organisation.id, deletedByUserId: auth.userId },
    select: { payload: true },
  });
  const snapshotEventId = undo && typeof undo.payload === "object" && undo.payload !== null && !Array.isArray(undo.payload)
    ? (undo.payload as Record<string, unknown>).eventId
    : null;
  if (snapshotEventId !== event.event.id) return notFound();
  const result = await restoreRsvpForUser(auth.userId, { organisationSlug: event.organisation.slug, undoId: body.data.undoId });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(null);
});
