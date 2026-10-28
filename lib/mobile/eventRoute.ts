import "server-only";

import { mobileError } from "@/lib/mobile/http";
import { resolveEventContext, type MobileEventContext } from "@/lib/mobile/organiser";
import { authedMobileRoute, type AuthedRouteContext, type RouteOptions } from "@/lib/mobile/route";
import type { EventPermissionsDto } from "@/lib/mobile/schemas";

type EventParams = { orgSlug: string; eventId: string };

/**
 * An organiser route scoped to one event. Events the caller cannot see on the
 * dashboard (including other organisations' ids) are NOT_FOUND; a visible
 * event without the needed permission is FORBIDDEN. Shared core functions
 * still re-check every mutation. `anyGrant` also admits the isolated grants
 * (JUDGE, MENTOR, REVIEW_APPLICATIONS), whose organiser flags are all false
 * but `fileClaims`: only the staff-claim routes use it.
 */
export function eventRoute<P extends EventParams = EventParams>(
  routeId: string,
  requirement: ((permissions: EventPermissionsDto) => boolean) | null,
  handler: (request: Request, params: P, context: AuthedRouteContext & { event: MobileEventContext }) => Promise<Response>,
  options: Pick<RouteOptions, "idempotent"> & { anyGrant?: boolean } = {},
) {
  return authedMobileRoute<P>(routeId, async (request, params, context) => {
    const event = await resolveEventContext(context.auth.userId, params.orgSlug, params.eventId, { anyGrant: options.anyGrant });
    if (!event) return mobileError("NOT_FOUND");
    if (requirement && !requirement(event.permissions)) return mobileError("FORBIDDEN");
    return handler(request, params, { ...context, event });
  }, { staff: true, idempotent: options.idempotent });
}
