import { z } from "zod";
import { unlockTickets } from "@/app/actions/promo";
import { mobileActionError, mobileOk, parseJsonBody } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { accessCodeDtoSchema } from "@/lib/mobile/schemas";

const bodySchema = z.object({
  orgSlug: z.string().max(120),
  eventSlug: z.string().max(200).optional(),
  eventInstanceId: z.string().max(128).optional(),
  code: z.string().max(32),
}).strict();

/** The tickets an access code unlocks; send the same `accessCode` with POST /rsvp to buy them. */
export const POST = mobileRoute("POST /api/mobile/v1/public/access-code/unlock", async (request) => {
  const body = await parseJsonBody(request, bodySchema);
  if ("response" in body) return body.response;
  const result = await unlockTickets(body.data);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(accessCodeDtoSchema.parse({ tickets: result.data ?? [] }));
}, { optionalAuth: true });
