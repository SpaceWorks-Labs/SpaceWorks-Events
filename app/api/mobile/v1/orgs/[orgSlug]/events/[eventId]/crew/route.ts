import { z } from "zod";
import { addCrewMember } from "@/app/actions/crew";
import { listCrewForOrganiser } from "@/lib/core/crew";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { crewListDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  role: z.string().max(80).optional(),
  foodPreference: z.string().max(80).optional(),
}).strict();

async function crewList(organisationId: string, eventId: string, actorUserId: string) {
  const { members, food } = await listCrewForOrganiser({ organisationId, eventId, actorUserId });
  return crewListDtoSchema.parse({
    members: members.map((member) => ({
      id: member.id, name: member.name, email: member.email, role: member.role, foodPreference: member.foodPreference,
      showOnPage: member.showOnPage, joinedViaLink: member.joinedViaLink, rsvpId: member.rsvpId, checkedInAt: member.checkedInAt,
    })),
    food,
  });
}

/** The event crew (docs/CREW.md) with their check-in and the food summary (MANAGE_REGISTRATIONS). */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/crew", (permissions) => permissions.manageCrew, async (_request, _params, { auth, event }) =>
  mobileOk(await crewList(event.organisation.id, event.event.id, auth.userId)));

/**
 * Add a crew member and email their free crew ticket, by Guests → Crew's own
 * action: never converts a paid ticket, a team member or an entrant.
 */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/crew", (permissions) => permissions.manageCrew, async (request, _params, { auth, event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await addCrewMember({ organisationSlug: event.organisation.slug, eventId: event.event.id, member: body.data });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await crewList(event.organisation.id, event.event.id, auth.userId), 201);
}, { idempotent: true });
