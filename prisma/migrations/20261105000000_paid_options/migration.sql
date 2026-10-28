-- Paid options (docs/TEAMS.md, docs/HACKATHON.md, docs/PAYMENTS.md): who pays
-- on a team event that sells tickets, the order a team or a project entry fee
-- belongs to, prize money with an append-only payout ledger, and check-in
-- lists limited to the buyers of an add-on. New columns are nullable or have
-- defaults, so no existing row is rewritten.
-- CreateEnum
CREATE TYPE "TeamTicketMode" AS ENUM ('PER_MEMBER', 'PER_TEAM');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "submissionFeeMinor" BIGINT,
ADD COLUMN     "submissionFeeRefundOnDisqualify" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "teamTicketMode" "TeamTicketMode" NOT NULL DEFAULT 'PER_MEMBER';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "submissionId" TEXT,
ADD COLUMN     "teamId" TEXT,
ADD COLUMN     "teamName" TEXT;

-- AlterTable
ALTER TABLE "CheckInList" ADD COLUMN     "addOnId" TEXT;

-- AlterTable
ALTER TABLE "EventAward" ADD COLUMN     "prizeMinor" BIGINT;

-- CreateTable
CREATE TABLE "PrizePayout" (
    "id" TEXT NOT NULL,
    "organisationId" TEXT NOT NULL,
    "eventId" TEXT,
    "awardId" TEXT,
    "submissionId" TEXT,
    "awardName" TEXT NOT NULL,
    "projectTitle" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" TEXT NOT NULL,
    "method" "OfflinePaymentMethod" NOT NULL,
    "reference" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "paidAt" TIMESTAMP(3) NOT NULL,
    "reversesId" TEXT,
    "recordedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrizePayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrizePayout_reversesId_key" ON "PrizePayout"("reversesId");

-- CreateIndex
CREATE INDEX "PrizePayout_eventId_createdAt_idx" ON "PrizePayout"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "PrizePayout_organisationId_createdAt_idx" ON "PrizePayout"("organisationId", "createdAt");

-- CreateIndex
CREATE INDEX "PrizePayout_awardId_idx" ON "PrizePayout"("awardId");

-- CreateIndex
CREATE INDEX "PrizePayout_submissionId_idx" ON "PrizePayout"("submissionId");

-- CreateIndex
CREATE INDEX "Order_teamId_idx" ON "Order"("teamId");

-- CreateIndex
CREATE INDEX "Order_submissionId_idx" ON "Order"("submissionId");

-- CreateIndex
CREATE INDEX "CheckInList_addOnId_idx" ON "CheckInList"("addOnId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInList" ADD CONSTRAINT "CheckInList_addOnId_fkey" FOREIGN KEY ("addOnId") REFERENCES "AddOn"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_awardId_fkey" FOREIGN KEY ("awardId") REFERENCES "EventAward"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "PrizePayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "Event" ADD CONSTRAINT "Event_submission_fee_positive" CHECK ("submissionFeeMinor" IS NULL OR "submissionFeeMinor" > 0);
ALTER TABLE "EventAward" ADD CONSTRAINT "EventAward_prize_positive" CHECK ("prizeMinor" IS NULL OR "prizeMinor" > 0);
-- An order pays for a team place or a project entry, never both.
ALTER TABLE "Order" ADD CONSTRAINT "Order_team_or_submission" CHECK (("teamId" IS NULL AND "teamName" IS NULL) OR "submissionId" IS NULL);
ALTER TABLE "Order" ADD CONSTRAINT "Order_team_name_length" CHECK ("teamName" IS NULL OR char_length("teamName") BETWEEN 1 AND 60);

ALTER TABLE "PrizePayout" ADD CONSTRAINT "PrizePayout_shape" CHECK (
  "amountMinor" > 0
  AND "currency" ~ '^[A-Z]{3}$'
  AND char_length("awardName") BETWEEN 1 AND 80
  AND char_length("projectTitle") BETWEEN 1 AND 120
  AND char_length("recipientName") BETWEEN 1 AND 120
  AND ("reference" IS NULL OR char_length("reference") <= 120)
  AND char_length("note") <= 500
  AND ("reversesId" IS NULL OR "reversesId" <> "id")
);

-- Payouts are a ledger: a row never changes, except that a reference is
-- cleared when what it points at is deleted (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION "prize_payout_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."organisationId" <> OLD."organisationId"
     OR NEW."awardName" <> OLD."awardName"
     OR NEW."projectTitle" <> OLD."projectTitle"
     OR NEW."recipientName" <> OLD."recipientName"
     OR NEW."amountMinor" <> OLD."amountMinor"
     OR NEW."currency" <> OLD."currency"
     OR NEW."method" <> OLD."method"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."note" <> OLD."note"
     OR NEW."paidAt" <> OLD."paidAt"
     OR NEW."createdAt" <> OLD."createdAt"
     OR (NEW."eventId" IS DISTINCT FROM OLD."eventId" AND NEW."eventId" IS NOT NULL)
     OR (NEW."awardId" IS DISTINCT FROM OLD."awardId" AND NEW."awardId" IS NOT NULL)
     OR (NEW."submissionId" IS DISTINCT FROM OLD."submissionId" AND NEW."submissionId" IS NOT NULL)
     OR (NEW."reversesId" IS DISTINCT FROM OLD."reversesId" AND NEW."reversesId" IS NOT NULL)
     OR (NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId" AND NEW."recordedByUserId" IS NOT NULL) THEN
    RAISE EXCEPTION 'Prize payouts are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "prize_payout_guard"
  BEFORE UPDATE ON "PrizePayout"
  FOR EACH ROW EXECUTE FUNCTION "prize_payout_guard"();

-- A reversal undoes exactly one payout of the same organisation, for the same
-- amount and currency, and is never itself reversed.
CREATE OR REPLACE FUNCTION "prize_payout_reversal_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  original RECORD;
BEGIN
  IF NEW."reversesId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "organisationId", "amountMinor", "currency", "reversesId" INTO original FROM "PrizePayout" WHERE "id" = NEW."reversesId";
  IF NOT FOUND OR original."organisationId" <> NEW."organisationId" OR original."amountMinor" <> NEW."amountMinor"
     OR original."currency" <> NEW."currency" OR original."reversesId" IS NOT NULL THEN
    RAISE EXCEPTION 'A reversal must match the payout it undoes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "prize_payout_reversal_guard"
  BEFORE INSERT ON "PrizePayout"
  FOR EACH ROW EXECUTE FUNCTION "prize_payout_reversal_guard"();

-- Chat channels can be told about payouts.
ALTER TABLE "ChatChannel" DROP CONSTRAINT "ChatChannel_shape";
ALTER TABLE "ChatChannel" ADD CONSTRAINT "ChatChannel_shape" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND "events" <@ ARRAY['registration', 'request', 'payment', 'refund', 'cancellation', 'dispute', 'event', 'payout']::TEXT[]
);
