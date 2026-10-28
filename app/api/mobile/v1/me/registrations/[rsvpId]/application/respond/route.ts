import { z } from "zod";
import { respondToMyApplication } from "@/lib/mobile/admission";
import { mobileActionError, mobileError, mobileOk, notFound, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { rsvpId: string };
const ROUTE = "POST /api/mobile/v1/me/registrations/:rsvpId/application/respond";
const bodySchema = z.object({ response: z.enum(["accept", "decline", "withdraw"]) }).strict();

/**
 * Answer the offer, or withdraw (the team leader for a team), with the same
 * rules as the ticket page. A free place is confirmed at once. A paid place
 * is held while it is paid: `checkoutUrl` opens the hosted payment page, and
 * the place is confirmed only when the payment lands (poll GET .../application).
 * Needs an Idempotency-Key, scoped to this registration.
 */
export const POST = authedMobileRoute<Params>(ROUTE, async (request, { rsvpId }, { auth }) =>
  idempotentWrite(request, auth.userId, `${ROUTE}:${rsvpId.slice(0, 64)}`, async (raw) => {
    const body = bodySchema.safeParse(raw ?? {});
    if (!body.success) return mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(body.error) });
    const result = await respondToMyApplication(auth.userId, rsvpId, body.data.response);
    if (!result) return notFound();
    return result.ok ? mobileOk(result.data) : mobileActionError(result);
  }));
