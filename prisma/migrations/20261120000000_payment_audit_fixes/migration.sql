-- Payment audit fixes (docs/PAYMENTS.md).
-- A failed refund is retried by a new row pointing at it; the unique index
-- lets each failed refund be retried once, even by two organisers at once.
-- Maintenance re-checks refunds the provider accepted but never finished,
-- oldest check first, so the batches stay fair.
ALTER TABLE "PaymentRefund" ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN "retryOfRefundId" TEXT;

CREATE UNIQUE INDEX "PaymentRefund_retryOfRefundId_key" ON "PaymentRefund"("retryOfRefundId");

CREATE INDEX "PaymentRefund_status_lastCheckedAt_idx" ON "PaymentRefund"("status", "lastCheckedAt");

ALTER TABLE "PaymentRefund" ADD CONSTRAINT "PaymentRefund_retryOfRefundId_fkey" FOREIGN KEY ("retryOfRefundId") REFERENCES "PaymentRefund"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
