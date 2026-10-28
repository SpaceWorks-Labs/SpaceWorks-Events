import { z } from "zod";
import { checkInToListForUser } from "@/lib/core/checkinLists/desk";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { listCheckInResultSchema } from "@/lib/mobile/schemas";

type Params = { orgSlug: string; eventId: string; listId: string };

const bodySchema = z.object({
  rawInput: z.string().max(2048).optional(),
  rsvpId: z.string().max(128).optional(),
  force: z.boolean().default(false),
}).strict().refine((value) => Boolean(value.rawInput) !== Boolean(value.rsvpId), { message: "Send exactly one of rawInput or rsvpId." });

/** Check a guest into a list by scanned ticket or by guest, with the desk's own rules (entry first, where the list asks). */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/check-in-lists/:listId/check-in", (permissions) => permissions.checkInToLists, async (request, { listId }, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await checkInToListForUser(auth.userId, { organisationSlug: event.organisation.slug, eventId: event.event.id, listId, ...body.data }, { source: body.data.rawInput ? "mobile-scan" : "mobile-manual" });
  if (!result.ok) return mobileActionError(result);
  return result.data ? mobileOk(listCheckInResultSchema.parse(result.data)) : mobileError("INTERNAL_ERROR");
});
