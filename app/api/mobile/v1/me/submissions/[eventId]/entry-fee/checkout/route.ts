import { prisma } from "@/lib/db";
import { mobileError, mobileOk, notFound } from "@/lib/mobile/http";
import { mySubmissionOn } from "@/lib/mobile/attendee";
import { authedMobileRoute } from "@/lib/mobile/route";
import { checkoutDtoSchema } from "@/lib/mobile/schemas";
import { openEntryFeeCheckout } from "@/lib/payments/entryFeeCheckout";
import { checkRateLimitById } from "@/lib/rateLimit";

/**
 * Pay the project's entry fee: the hosted payment page, opened in the system
 * browser. A project saved but unpaid is submitted once the fee is paid.
 * CONFLICT when nothing is owed.
 */
export const POST = authedMobileRoute<{ eventId: string }>("POST /api/mobile/v1/me/submissions/:eventId/entry-fee/checkout", async (_request, { eventId }, { auth }) => {
  if (!(await checkRateLimitById("ticketCheckout", `user:${auth.userId}`))) return mobileError("RATE_LIMITED");
  const submission = await mySubmissionOn(auth.userId, eventId);
  if (!submission) return notFound();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { email: true, name: true } });
  if (!user.email) return mobileError("FORBIDDEN");
  const checkout = await openEntryFeeCheckout({ eventId, submissionId: submission.id, buyer: { userId: auth.userId, email: user.email, name: user.name ?? user.email } });
  if ("url" in checkout) return mobileOk(checkoutDtoSchema.parse({ checkoutUrl: checkout.url }));
  if ("paid" in checkout) return mobileError("CONFLICT", "The entry fee is already paid.");
  return mobileError("PAYMENT_UNAVAILABLE", checkout.error);
});
