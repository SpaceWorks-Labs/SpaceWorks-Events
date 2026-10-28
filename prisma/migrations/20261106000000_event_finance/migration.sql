-- Event finance (docs/FINANCE.md): expense claims from staff and participants
-- with private receipt photos, an append-only claim payout ledger, refund
-- requests outside the automatic policy, and an event budget. New tables and
-- nullable or defaulted columns only; no existing row is rewritten.
-- CreateEnum
CREATE TYPE "ExpenseClaimKind" AS ENUM ('STAFF', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "ExpenseClaimStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'PAID', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('TRAVEL', 'ACCOMMODATION', 'FOOD', 'VENUE', 'EQUIPMENT', 'PRINTING', 'MARKETING', 'SUPPLIES', 'OTHER');

-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('OPEN', 'APPROVED', 'DECLINED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "budgetMinor" BIGINT,
ADD COLUMN     "participantClaimCapMinor" BIGINT,
ADD COLUMN     "participantClaimsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ExpenseClaim" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventId" TEXT,
    "eventTitle" TEXT NOT NULL,
    "kind" "ExpenseClaimKind" NOT NULL,
    "status" "ExpenseClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedByUserId" TEXT,
    "rsvpId" TEXT,
    "payeeName" TEXT NOT NULL,
    "payeeEmail" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "approvedMinor" BIGINT,
    "currency" TEXT NOT NULL,
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseReceipt" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClaimPayout" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventId" TEXT,
    "claimId" TEXT,
    "payeeName" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "OfflinePaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reversesId" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClaimPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT NOT NULL,
    "approvedMinor" BIGINT,
    "cancelTickets" BOOLEAN NOT NULL DEFAULT false,
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExpenseClaim_eventId_status_createdAt_idx" ON "ExpenseClaim"("eventId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ExpenseClaim_organisationId_createdAt_idx" ON "ExpenseClaim"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "ExpenseClaim_submittedByUserId_idx" ON "ExpenseClaim"("submittedByUserId");

-- CreateIndex
CREATE INDEX "ExpenseClaim_rsvpId_idx" ON "ExpenseClaim"("rsvpId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseReceipt_storageKey_key" ON "ExpenseReceipt"("storageKey");

-- CreateIndex
CREATE INDEX "ExpenseReceipt_claimId_idx" ON "ExpenseReceipt"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ClaimPayout_reversesId_key" ON "ClaimPayout"("reversesId");

-- CreateIndex
CREATE INDEX "ClaimPayout_eventId_createdAt_idx" ON "ClaimPayout"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimPayout_organisationId_createdAt_idx" ON "ClaimPayout"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "ClaimPayout_claimId_idx" ON "ClaimPayout"("claimId");

-- CreateIndex
CREATE INDEX "RefundRequest_orderId_status_idx" ON "RefundRequest"("orderId", "status");

-- CreateIndex
CREATE INDEX "RefundRequest_organisationId_status_createdAt_idx" ON "RefundRequest"("organisationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_submittedByUserId_fkey" FOREIGN KEY ("submittedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseReceipt" ADD CONSTRAINT "ExpenseReceipt_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "ExpenseClaim"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "ClaimPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "Event" ADD CONSTRAINT "Event_finance_amounts" CHECK (("budgetMinor" IS NULL OR "budgetMinor" > 0) AND ("participantClaimCapMinor" IS NULL OR "participantClaimCapMinor" > 0));

ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_shape" CHECK (
  "amountMinor" > 0
  AND ("approvedMinor" IS NULL OR ("approvedMinor" > 0 AND "approvedMinor" <= "amountMinor"))
  AND ("status" NOT IN ('APPROVED', 'PAID') OR "approvedMinor" IS NOT NULL)
  AND "currency" ~ '^[A-Z]{3}$'
  AND char_length("eventTitle") BETWEEN 1 AND 200
  AND char_length("payeeName") BETWEEN 1 AND 120
  AND char_length("payeeEmail") BETWEEN 3 AND 254
  AND char_length("description") BETWEEN 1 AND 1000
  AND char_length("decisionNote") <= 500
);

-- Receipts live only under the organisation's private claim-receipts prefix.
ALTER TABLE "ExpenseReceipt" ADD CONSTRAINT "ExpenseReceipt_shape" CHECK (
  "storageKey" ~ '^organisations/[A-Za-z0-9_-]{1,128}/claim-receipts/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
  AND "byteSize" > 0
);

ALTER TABLE "ClaimPayout" ADD CONSTRAINT "ClaimPayout_shape" CHECK (
  "amountMinor" > 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND char_length("payeeName") BETWEEN 1 AND 120
  AND ("reference" IS NULL OR char_length("reference") <= 120)
  AND char_length("note") <= 500
  AND ("reversesId" IS NULL OR "reversesId" <> "id")
);

-- Claim payouts are a ledger, guarded like prize payouts.
CREATE OR REPLACE FUNCTION "claim_payout_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."organisationId" <> OLD."organisationId"
     OR NEW."payeeName" <> OLD."payeeName"
     OR NEW."amountMinor" <> OLD."amountMinor"
     OR NEW."currency" <> OLD."currency"
     OR NEW."method" <> OLD."method"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."note" <> OLD."note"
     OR NEW."paidAt" <> OLD."paidAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (NEW."eventId" IS DISTINCT FROM OLD."eventId" AND NEW."eventId" IS NOT NULL)
     OR (NEW."claimId" IS DISTINCT FROM OLD."claimId" AND NEW."claimId" IS NOT NULL)
     OR (NEW."reversesId" IS DISTINCT FROM OLD."reversesId" AND NEW."reversesId" IS NOT NULL)
     OR (NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId" AND NEW."recordedByUserId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Claim payouts are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "claim_payout_guard"
  BEFORE UPDATE ON "ClaimPayout"
  FOR EACH ROW EXECUTE FUNCTION "claim_payout_guard"();

CREATE OR REPLACE FUNCTION "claim_payout_reversal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original RECORD;
BEGIN
  IF NEW."reversesId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "organisationId", "amountMinor", "currency", "reversesId" INTO original FROM "ClaimPayout" WHERE "id" = NEW."reversesId";
  IF NOT FOUND OR original."organisationId" <> NEW."organisationId" OR original."amountMinor" <> NEW."amountMinor"
     OR original."currency" <> NEW."currency" OR original."reversesId" IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal must match the payout it undoes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "claim_payout_reversal_guard"
  BEFORE INSERT ON "ClaimPayout"
  FOR EACH ROW EXECUTE FUNCTION "claim_payout_reversal_guard"();

ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_shape" CHECK (
  char_length("reason") BETWEEN 1 AND 1000
  AND ("approvedMinor" IS NULL OR "approvedMinor" >= 0)
  AND char_length("decisionNote") <= 500
);
-- One open request per order at a time.
CREATE UNIQUE INDEX "RefundRequest_one_open_per_order" ON "RefundRequest"("orderId") WHERE "status" = 'OPEN';

-- Chat channels can be told about expense claims.
ALTER TABLE "ChatChannel" DROP CONSTRAINT "ChatChannel_shape";
ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_shape" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND "events" <@ ARRAY['registration', 'request', 'payment', 'refund', 'cancellation', 'dispute', 'event', 'payout', 'claim']::TEXT[]
);
