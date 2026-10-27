import { submitStaffClaimAction } from "@/app/actions/finance";
import { loadMyStaffClaims } from "@/lib/mobile/attendee";
import { eventRoute } from "@/lib/mobile/eventRoute";
import { loadEventClaims } from "@/lib/mobile/finance";
import { mobileActionError, mobileError, mobileOk } from "@/lib/mobile/http";

const MAX_BYTES = 16 * 1024 * 1024;

/** Every claim and refund request on the event (organisation owners and admins). */
export const GET = eventRoute("GET /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/claims", (permissions) => permissions.manageFinance, async (_request, _params, { event }) =>
  mobileOk(await loadEventClaims(event.event.id)));

/**
 * File a claim (multipart: `category`, `description`, `amount`, `payeeName`,
 * `payeeEmail` and up to three `receipts` photos), by the Finance tab's own
 * action. Anyone on the event dashboard may file.
 */
export const POST = eventRoute("POST /api/mobile/v1/orgs/:orgSlug/events/:eventId/finance/claims", (permissions) => permissions.fileClaims, async (request, _params, { auth, event }) => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BYTES) return mobileError("INVALID_REQUEST", "Request is too large.");
  const form = await request.formData().catch(() => null);
  if (!form) return mobileError("INVALID_REQUEST", "Send the claim as a multipart form.");
  const fields = new FormData();
  fields.set("organisationSlug", event.organisation.slug);
  fields.set("eventId", event.event.id);
  for (const name of ["category", "description", "amount", "payeeName", "payeeEmail"]) fields.set(name, String(form.get(name) ?? ""));
  for (const file of form.getAll("receipts")) if (file instanceof File) fields.append("receipts", file);
  const result = await submitStaffClaimAction(fields);
  if (!result.ok) return mobileActionError(result);
  return mobileOk(await loadMyStaffClaims(auth.userId, event.event.id), 201);
});
