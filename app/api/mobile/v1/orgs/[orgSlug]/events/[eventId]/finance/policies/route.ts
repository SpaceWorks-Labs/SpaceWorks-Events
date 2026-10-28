import { eventRoute } from "@/lib/mobile/eventRoute";
import { loadEventPolicies } from "@/lib/mobile/finance";
import { mobileOk } from "@/lib/mobile/http";

/** The event's reimbursement policies with what each has used (organisation owners and admins). Editing stays on the website. */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/policies", (permissions) => permissions.manageFinance, async (_request, _params, { event }) =>
  mobileOk(await loadEventPolicies(event.event.id)));
