import { getMobileGoogleConfig } from "@/lib/googleSignIn";
import { isNewUserRegistrationEnabled, isPaidEventsEnabled } from "@/lib/instanceSettings";
import { mobileOk } from "@/lib/mobile/http";
import { mobileRoute } from "@/lib/mobile/route";
import { authConfigDtoSchema } from "@/lib/mobile/schemas";

export const GET = mobileRoute("GET /api/mobile/v1/auth/config", async (_request, _params, { baseUrl }) => {
  const [google, signupEnabled, paidEventsEnabled] = await Promise.all([getMobileGoogleConfig(), isNewUserRegistrationEnabled(), isPaidEventsEnabled()]);
  return mobileOk(authConfigDtoSchema.parse({
    instanceName: "Space Works Events",
    googleSignIn: { enabled: Boolean(google), webClientId: google?.webClientId ?? null },
    signupEnabled,
    paidEventsEnabled,
    baseUrl,
  }));
});
