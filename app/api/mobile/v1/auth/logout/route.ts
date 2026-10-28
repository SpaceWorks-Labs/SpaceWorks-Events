import { revokeMobileSession } from "@/lib/mobileAuth";
import { mobileOk } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";

export const POST = authedMobileRoute("POST /api/mobile/v1/auth/logout", async (_request, _params, { auth }) => {
  await revokeMobileSession(auth);
  return mobileOk(null);
});
