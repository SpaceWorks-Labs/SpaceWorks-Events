import "server-only";

import { Prisma } from "@prisma/client";

/**
 * SQL fragments use the Order alias `o`. Cancellation status and the existing
 * ledger are the durable obligation: saved together with cancellation, before
 * the first refund row exists. A pass keeps a cancelled date's registrations
 * until its share is recorded and those places are removed in one transaction.
 */
export const cancelledTargetSql = Prisma.sql`(
  EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = o."eventId" AND e."status" = 'CANCELLED')
  OR EXISTS (SELECT 1 FROM "EventSeries" s WHERE s."id" = o."eventSeriesId" AND s."status" = 'CANCELLED')
  OR EXISTS (SELECT 1 FROM "EventInstance" d WHERE d."id" = o."eventInstanceId" AND d."cancelledAt" IS NOT NULL)
  OR EXISTS (SELECT 1 FROM "RSVP" v JOIN "EventInstance" d ON d."id" = v."eventInstanceId"
    WHERE v."orderId" = o."id" AND d."cancelledAt" IS NOT NULL)
)`;

/** Pending refunds reserve their money; failed refunds leave it refundable. */
export const refundableBalanceSql = Prisma.sql`(
  SELECT COALESCE(SUM(p."amountMinor" - COALESCE((
    SELECT SUM(r."amountMinor") FROM "PaymentRefund" r
    WHERE r."paymentId" = p."id" AND r."status" IN ('PENDING', 'SUCCEEDED')
  ), 0)), 0)::bigint FROM "Payment" p
  WHERE p."orderId" = o."id" AND p."status" IN ('PAID_ONLINE', 'PAID_OFFLINE')
)`;

/** Money-only refunds also resolve checked-in orders on cancelled targets. */
export const refundableOrderSql = Prisma.sql`(
  o."status" IN ('CANCELLED', 'EXPIRED')
  OR (o."status" = 'CONFIRMED' AND ${cancelledTargetSql})
)`;
