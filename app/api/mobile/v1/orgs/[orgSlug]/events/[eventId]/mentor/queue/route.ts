import { z } from "zod";
import { mobileError, mobileOk, parseQuery } from "@/lib/mobile/http";
import { mentorRoute } from "@/lib/mobile/mentor";
import { mentorQueue } from "@/lib/mobile/mentorReads";

const querySchema = z.object({ cursor: z.string().max(64).optional() }).strict();

/**
 * Open help this mentor may see, priority first (never their own team's or a
 * conflicted team's), 25 at a time. `eligible` says whether they may claim it
 * now (assignment priority window, skills).
 */
export const GET = mentorRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/mentor/queue", async (request, _params, { mentor }) => {
  const query = parseQuery(request, querySchema);
  if ("response" in query) return query.response;
  const page = await mentorQueue(mentor, query.data.cursor);
  if (page === undefined) return mobileError("INVALID_REQUEST", "Invalid cursor.");
  return page ? mobileOk(page) : mobileError("NOT_FOUND");
});
