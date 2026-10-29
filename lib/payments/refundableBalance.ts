import "server-only";

import { Prisma } from "@prisma/client";

/**
 * SQL fragments use the Order alias `o`. Event/date cancellation and the existing
 * ledger are the durable obligation: saved together with cancellation, before
 * the first refund row exists. A pass keeps a cancelled date's registrations
 * until its share is recorded and those places are removed in one transaction.
 * A series status alone says nothing about cancellation of an earlier date.
 */
export const cancelledTargetSql = Prisma.sql`(
  EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = o."eventId" AND e."status" = 'CANCELLED')
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

/**
 * Manual money-only refunds must never precede an automatic pass share.
 * A check-in on the cancelled target prevents automatic cancellation; for a
 * pass, every still-attached cancelled date must have such a check-in. A
 * check-in on another date does not prevent that date's automatic share.
 * Keep cancelledTargetSql broader: pending automatic work still blocks deletion.
 */
const manuallyRefundableTargetSql = Prisma.sql`(
  EXISTS (SELECT 1 FROM "RSVP" v WHERE v."orderId" = o."id" AND v."checkedInAt" IS NOT NULL
    AND (
      EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = v."eventId" AND e."status" = 'CANCELLED')
      OR EXISTS (SELECT 1 FROM "EventInstance" d WHERE d."id" = v."eventInstanceId" AND d."cancelledAt" IS NOT NULL)
    ))
  AND NOT EXISTS (
    SELECT 1 FROM "RSVP" v JOIN "EventInstance" d ON d."id" = v."eventInstanceId"
    WHERE v."orderId" = o."id" AND d."cancelledAt" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "RSVP" checked WHERE checked."orderId" = o."id"
        AND checked."eventInstanceId" = d."id" AND checked."checkedInAt" IS NOT NULL)
  )
)`;

/** Ended orders, or cancelled targets that automatic refunds cannot handle. */
export const refundableOrderSql = Prisma.sql`(
  o."status" IN ('CANCELLED', 'EXPIRED')
  OR (o."status" = 'CONFIRMED' AND ${cancelledTargetSql} AND ${manuallyRefundableTargetSql})
)`;
