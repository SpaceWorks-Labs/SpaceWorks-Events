import crypto from "node:crypto";
import { OrderStatus, RsvpStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { teamRegistrationIntentSchema } from "@/lib/validators";
import { mobileActionError, mobileError, mobileOk, readJsonBody, zodFieldErrors } from "@/lib/mobile/http";
import { idempotentRequest } from "@/lib/mobile/idempotency";
import { mobileRoute } from "@/lib/mobile/route";
import { rsvpResultDtoSchema } from "@/lib/mobile/schemas";
import { checkRateLimitById, getClientIpFromHeaders } from "@/lib/rateLimit";

function field(body: unknown, key: string) {
  return typeof body === "object" && body !== null && key in body ? (body as Record<string, unknown>)[key] : undefined;
}

function stringField(body: unknown, key: string) {
  const value = field(body, key);
  return typeof value === "string" ? value : null;
}

/**
 * Same body, service and limits as POST /api/rsvp, including tickets
 * (`items`, `ticketTypeId`, `addOns`, `promoCode`, `accessCode`,
 * `attendees`, `payAtDesk`) and team intents (`team`). A valid bearer
 * identifies the attendee; otherwise the guest flow applies, which cannot
 * buy tickets (sign in so the order shows under /me/orders).
 *
 * A paid registration is never a ticket until paid: it answers
 * PENDING_PAYMENT with the order id, the hosted checkout address (open it in
 * the system browser) and when the hold ends. A paid request on an approval
 * event answers PENDING_APPROVAL with its order id. The order's access token
 * is never returned.
 *
 * Signed in, it needs an Idempotency-Key, so a retried tap never registers or
 * orders twice (a replayed answer carries `ticketToken: null`; read the
 * registration for it). The guest flow has no account to hold keys; its
 * duplicate check by email applies instead.
 */
const ROUTE = "POST /api/mobile/v1/rsvp";
const MAX_BYTES = 128 * 1024;

async function register(request: Request, auth: { userId: string } | null) {
  const body = await readJsonBody(request, MAX_BYTES);
  if ("response" in body) return body.response;

  const guestEmail = stringField(body.value, "guestEmail")?.trim().toLowerCase() ?? null;
  const subjects = [`ip:${getClientIpFromHeaders(request.headers)}`];
  if (guestEmail) subjects.push(`subject:${crypto.createHash("sha256").update(guestEmail).digest("hex").slice(0, 32)}`);
  const limits = await Promise.all(subjects.map((subject) => checkRateLimitById("rsvp", subject)));
  if (limits.some((allowed) => !allowed)) return mobileError("RATE_LIMITED", "Too many registration attempts. Please try again shortly.");

  const buysTickets = field(body.value, "items") !== undefined || field(body.value, "ticketTypeId") !== undefined;
  if (buysTickets && !auth) return mobileError("UNAUTHENTICATED", "Sign in to buy tickets in the app.");

  const rawTeam = field(body.value, "team");
  let team;
  if (rawTeam !== undefined && rawTeam !== null) {
    const parsedTeam = teamRegistrationIntentSchema.safeParse(rawTeam);
    if (!parsedTeam.success) return mobileError("INVALID_REQUEST", "Check the team details and try again.", { fieldErrors: zodFieldErrors(parsedTeam.error) });
    team = parsedTeam.data;
  }

  const result = await submitRsvpCore(body.value, { userId: auth?.userId ?? null, team });
  if (!result.ok) return mobileActionError(result);
  if (!result.data) return mobileError("INTERNAL_ERROR");

  const orgSlug = stringField(body.value, "orgSlug");
  const eventSlug = stringField(body.value, "eventSlug");
  const eventInstanceId = stringField(body.value, "eventInstanceId");
  if (orgSlug) {
    if (eventSlug) revalidatePath(`/${orgSlug}/${eventSlug}`);
    if (eventInstanceId) revalidatePath(`/${orgSlug}/i/${eventInstanceId}`);
    revalidatePath(`/${orgSlug}`);
  }

  const rsvp = await prisma.rSVP.findUnique({ where: { checkInToken: result.data.ticketToken }, select: { id: true, status: true } });
  const order = result.data.orderToken
    ? await prisma.order.findUnique({ where: { accessToken: result.data.orderToken }, select: { id: true, status: true, holdExpiresAt: true } })
    : null;
  if (order && order.status === OrderStatus.REQUESTED) {
    return mobileOk(rsvpResultDtoSchema.parse({ rsvpId: rsvp?.id ?? null, status: "PENDING_APPROVAL", ticketToken: null, orderId: order.id, checkoutUrl: null, holdExpiresAt: null }));
  }
  if (order && order.status === OrderStatus.PENDING) {
    return mobileOk(rsvpResultDtoSchema.parse({
      rsvpId: rsvp?.id ?? null,
      status: "PENDING_PAYMENT",
      ticketToken: null,
      orderId: order.id,
      checkoutUrl: result.data.checkoutUrl ?? null,
      holdExpiresAt: order.holdExpiresAt?.toISOString() ?? null,
    }));
  }
  if (!rsvp) return mobileError("INTERNAL_ERROR");
  if (rsvp.status === RsvpStatus.REJECTED || rsvp.status === RsvpStatus.PENDING_PAYMENT) return mobileError("CONFLICT");
  return mobileOk(rsvpResultDtoSchema.parse({
    rsvpId: rsvp.id,
    status: rsvp.status,
    // A ticket only for a confirmed place: a free registration, or an order already paid or free.
    ticketToken: rsvp.status === RsvpStatus.CONFIRMED ? result.data.ticketToken : null,
  }));
}

export const POST = mobileRoute(ROUTE, async (request, _params, { auth }) => (auth
  ? idempotentRequest(request, auth.userId, ROUTE, (copy) => register(copy, auth), MAX_BYTES)
  : register(request, null)), { optionalAuth: true });
