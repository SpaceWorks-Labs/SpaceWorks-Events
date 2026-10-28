import { z } from "zod";
import { checkPromoCode } from "@/app/actions/promo";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { promoCheckDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({
  orgSlug: z.string().max(120),
  eventSlug: z.string().max(200).optional(),
  eventInstanceId: z.string().max(128).optional(),
  code: z.string().max(32),
}).strict();

/** Check a promo code to preview the discounted total (the registration form's own check; rate limited). */
export const POST = mobileRoute("POST /api/mobile/v1/public/promo/check", async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await checkPromoCode(body.data);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(promoCheckDtoSchema.parse(result.data));
}, { optionalAuth: true });
