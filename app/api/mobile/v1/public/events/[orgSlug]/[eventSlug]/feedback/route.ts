import { mobileOk, notFound } from "@/lib/mobile/http";
import { slugParam } from "@/lib/mobile/inputs";
import { loadPublicFeedbackForm } from "@/lib/mobile/publicEvents";
import { mobileRoute } from "@/lib/mobile/route";

export const GET = mobileRoute<{ orgSlug: string; eventSlug: string }>(
  "GET /api/mobile/v1/public/events/:orgSlug/:eventSlug/feedback",
  async (_request, params) => {
    const orgSlug = slugParam.safeParse(params.orgSlug);
    const eventSlug = slugParam.safeParse(params.eventSlug);
    if (!orgSlug.success || !eventSlug.success) return notFound();
    const form = await loadPublicFeedbackForm(orgSlug.data, eventSlug.data);
    return form ? mobileOk(form) : notFound();
  },
);
