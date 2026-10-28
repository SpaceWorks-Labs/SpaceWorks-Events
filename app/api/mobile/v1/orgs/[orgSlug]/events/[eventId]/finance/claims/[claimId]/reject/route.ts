import { z } from "zod";
import { rejectClaimAction } from "@/app/actions/finance";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { loadEventClaims } from "@/lib/mobile/finance";
import { mobileActionError, mobileOk, notFound, parseJsonBody } from "@/lib/mobile/http";
import { prisma } from "@/lib/db";

type Params = { orgSlug: string; eventId: string; claimId: string };

const bodySchema = z.object({ note: z.string().max(500).optional() }).strict();

/** Decline a claim, with a note to the claimant. */
export const POST = eventRoute<Params>("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/claims/:claimId/reject", (permissions) => permissions.manageFinance, async (request, { claimId }, { event }) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  // Decisions are organisation-wide on the web; here the claim must be on the event in the path.
  if (!(await prisma.expenseClaim.findFirst({ where: { id: claimId, eventId: event.event.id }, select: { id: true } }))) return notFound();
  const result = await rejectClaimAction({ organisationSlug: event.organisation.slug, eventId: event.event.id }, { claimId, ...body.data });
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadEventClaims(event.event.id));
});
