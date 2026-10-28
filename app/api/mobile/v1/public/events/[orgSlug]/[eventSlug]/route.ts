import { mobileOk, notFound } from "@/lib/mobile/http";
import { slugParam } from "@/lib/mobile/inputs";
import { loadPublicEvent } from "@/lib/mobile/publicEvents";
import { mobileRoute } from "@/lib/mobile/route";

export const GET = mobileRoute<{ orgSlug: string; eventSlug: string }>(
  "GET /api/mobile/v1/public/events/:orgSlug/:eventSlug",
  async (_request, params, { auth, baseUrl }) => {
    const orgSlug = slugParam.safeParse(params.orgSlug);
    const eventSlug = slugParam.safeParse(params.eventSlug);
    if (!orgSlug.success || !eventSlug.success) return notFound();
    const event = await loadPublicEvent({ orgSlug: orgSlug.data, eventSlug: eventSlug.data, viewerUserId: auth?.userId ?? null, baseUrl });
    return event ? mobileOk(event) : notFound();
  },
  { optionalAuth: true },
);
