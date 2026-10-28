import { z } from "zod";
import { mobileOk, notFound, parseQuery } from "@/lib/mobile/http";
import { listOrgEvents } from "@/lib/mobile/organiser";
import { authedMobileRoute } from "@/lib/mobile/route";

const querySchema = z.object({ filter: z.enum(["upcoming", "past", "all"]).default("upcoming") }).strict();

export const GET = authedMobileRoute<{ orgSlug: string }>("GET /api/mobile/v1/orgs/:orgSlug/events", async (request, { orgSlug }, { auth, baseUrl }) => {
  const query = parseQuery(request, querySchema);
  if ("response" in query) return query.response;
  const result = await listOrgEvents(auth.userId, orgSlug, query.data.filter, baseUrl);
  return result ? mobileOk(result) : notFound();
}, { staff: true });
