import { checkoutForBuyer } from "@/lib/core/orders/buyer";
import { mobileError, mobileOk, notFound } from "@/lib/mobile/http";
import { authedMobileRoute } from "@/lib/mobile/route";
import { checkoutDtoSchema } from "@/lib/mobile/schemas";
import { checkRateLimitById } from "@/lib/rateLimit";

const MESSAGES: Record<string, string> = {
  hold_ended: "These tickets are no longer held. Order again if tickets are left.",
  hold_ending: "Your hold is about to end, so a new payment page can't open. Order again in a moment.",
};

/**
 * Open (or reopen) the hosted payment page for a held order. Open the
 * address in the system browser (Custom Tabs or ASWebAuthenticationSession),
 * then poll GET /me/orders/:orderId: the provider's webhook confirms it.
 */
export const POST = authedMobileRoute<{ orderId: string }>("POST /api/mobile/v1/me/orders/:orderId/checkout", async (_request, { orderId }, { auth }) => {
  if (!(await checkRateLimitById("ticketCheckout", `user:${auth.userId}`))) return mobileError("RATE_LIMITED");
  const outcome = await checkoutForBuyer(orderId, auth.userId);
  if ("url" in outcome) return mobileOk(checkoutDtoSchema.parse({ checkoutUrl: outcome.url }));
  if (outcome.error === "not_found") return notFound();
  if (outcome.error === "busy" || outcome.error === "unavailable") return mobileError("PAYMENT_UNAVAILABLE");
  return mobileError("CONFLICT", MESSAGES[outcome.error]);
}, { idempotent: true });
