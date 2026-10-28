import { mobileOk } from "@/lib/mobile/http";
import { listMyPrizes } from "@/lib/mobile/attendee";
import { authedMobileRoute } from "@/lib/mobile/route";

/** Prizes the caller's projects won, with payouts (amount and date only). */
export const GET = authedMobileRoute("GET /api/mobile/v1/me/prizes", async (_request, _params, { auth }) => mobileOk(await listMyPrizes(auth.userId)));
