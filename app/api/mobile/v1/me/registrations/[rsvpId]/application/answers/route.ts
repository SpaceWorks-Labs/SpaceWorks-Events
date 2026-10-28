import { z } from "zod";
import { loadMyApplication, saveMyApplicationAnswers } from "@/lib/mobile/admission";
import { mobileActionError, mobileError, mobileOk, notFound, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentWrite } from "@/lib/mobile/idempotency";
import { authedMobileRoute } from "@/lib/mobile/route";

type Params = { rsvpId: string };
const ROUTE = "PUT /api/mobile/v1/me/registrations/:rsvpId/application/answers";
const bodySchema = z.object({ answers: z.record(z.string().max(100), z.unknown()) }).strict();

/**
 * Replace the caller's own answers while the application is in review and
 * no decision has been released (the same validation as registering). The
 * replaced answers are kept, and reviews of them stop counting. Answers with
 * the application as GET returns it. Needs an Idempotency-Key.
 */
export const PUT = authedMobileRoute<Params>(ROUTE, async (request, { rsvpId }, { auth }) =>
  idempotentWrite(request, auth.userId, `${ROUTE}:${rsvpId.slice(0, 64)}`, async (raw) => {
    const body = bodySchema.safeParse(raw ?? {});
    if (!body.success) return mobileError("INVALID_REQUEST", undefined, { fieldErrors: zodFieldErrors(body.error) });
    const result = await saveMyApplicationAnswers(auth.userId, rsvpId, body.data.answers);
    if (!result) return notFound();
    if (!result.ok) return mobileActionError(result);
    const application = await loadMyApplication(auth.userId, rsvpId);
    return application ? mobileOk(application) : notFound();
  }));
