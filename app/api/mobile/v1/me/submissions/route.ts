import { mobileOk } from "@/lib/mobile/http";
import { listMySubmissions } from "@/lib/mobile/attendee";
import { authedMobileRoute } from "@/lib/mobile/route";

/** The caller's hackathon projects, one per event, with the entry fee and whether it is paid. */
export const GET = authedMobileRoute("GET /api/mobile/v1/me/submissions", async (_request, _params, { auth }) => mobileOk(await listMySubmissions(auth.userId)));
