import { mobileOk, notFound } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { loadSeriesDate } from "@/lib/mobile/series";

/**
 * One date of a recurring series, with its tickets, passes and the next
 * dates; the same access rule as /:orgSlug/i/:instanceId. A bearer, if sent,
 * identifies the viewer (members-only tickets, their own registration).
 */
export const GET = mobileRoute<{ orgSlug: string; instanceId: string }>("GET /api/mobile/v1/public/series/:orgSlug/i/:instanceId", async (_request, { orgSlug, instanceId }) => {
  const date = await loadSeriesDate(orgSlug, instanceId);
  return date ? mobileOk(date) : notFound();
}, { optionalAuth: true });
