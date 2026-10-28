import { isActionRateLimited } from "@/lib/actionRateLimit";
import { mobileOk, notFound } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { shortLinkDtoSchema } from "@/lib/mobile/schemas";
import { isShortCodeShape } from "@/lib/shortLink";
import { resolveShortCode } from "@/lib/shortLinkResolve";

/** Same rule and per-IP limit as /:shortCode; unknown, unreleased and limited codes are one NOT_FOUND. */
export const GET = mobileRoute<{ code: string }>("GET /api/mobile/v1/public/short/:code", async (_request, { code }) => {
  if (!isShortCodeShape(code)) return notFound();
  if (await isActionRateLimited("shortLink")) return notFound();
  const path = await resolveShortCode(code);
  if (!path) return notFound();
  const [, orgSlug, eventSlug] = path.split("/");
  if (!orgSlug || !eventSlug) return notFound();
  return mobileOk(shortLinkDtoSchema.parse({ orgSlug, eventSlug }));
});
