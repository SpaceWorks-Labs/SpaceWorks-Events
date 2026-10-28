import { loadMyRegistrations } from "@/lib/mobile/account";
import { mobileOk } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

export const GET = authedMobileRoute("GET /api/mobile/v1/me/registrations", async (_request, _params, { auth, baseUrl }) =>
  mobileOk(await loadMyRegistrations(auth.userId, baseUrl)));
