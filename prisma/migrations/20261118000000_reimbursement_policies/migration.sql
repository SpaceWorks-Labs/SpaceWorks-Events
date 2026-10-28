-- Per-stage reimbursement policies (docs/FINANCE.md "Reimbursement policies").

-- CreateEnum
CREATE TYPE "ReimbursementEligibility" AS ENUM ('CONFIRMED_PARTICIPANT', 'CREW', 'JUDGING_ROUND_ENTRY', 'MENTORING_ROUND');

-- CreateTable
CREATE TABLE "ReimbursementPolicy" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eligibility" "ReimbursementEligibility" NOT NULL,
    "judgingRoundId" TEXT,
    "mentoringRoundId" TEXT,
    "requireFinalistsPublished" BOOLEAN NOT NULL DEFAULT false,
    "capPerPersonMinor" BIGINT NOT NULL,
    "categories" "ExpenseCategory"[],
    "claimOpensAt" TIMESTAMP(3),
    "claimClosesAt" TIMESTAMP(3),
    "attendanceRequired" BOOLEAN NOT NULL DEFAULT false,
    "budgetMinor" BIGINT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notifyWhenAvailable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReimbursementPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursementNotice" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReimbursementNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReimbursementPolicy_eventId_active_idx" ON "ReimbursementPolicy"("eventId", "active");

-- CreateIndex
CREATE INDEX "ReimbursementPolicy_judgingRoundId_idx" ON "ReimbursementPolicy"("judgingRoundId");

-- CreateIndex
CREATE INDEX "ReimbursementPolicy_mentoringRoundId_idx" ON "ReimbursementPolicy"("mentoringRoundId");

-- CreateIndex
CREATE INDEX "ReimbursementNotice_rsvpId_idx" ON "ReimbursementNotice"("rsvpId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursementNotice_policyId_rsvpId_key" ON "ReimbursementNotice"("policyId", "rsvpId");

-- AddForeignKey
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: NO ACTION, so a stage in use can't be deleted on its own, but
-- deleting the whole event (which cascades to both) still works.
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_judgingRoundId_fkey" FOREIGN KEY ("judgingRoundId") REFERENCES "JudgingRound"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_mentoringRoundId_fkey" FOREIGN KEY ("mentoringRoundId") REFERENCES "MentoringRound"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementNotice" ADD CONSTRAINT "ReimbursementNotice_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ReimbursementPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursementNotice" ADD CONSTRAINT "ReimbursementNotice_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Name, positive amounts, at least one category, and an ordered window.
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_shape" CHECK (
  char_length("name") BETWEEN 1 AND 80
  AND "capPerPersonMinor" > 0
  AND ("budgetMinor" IS NULL OR "budgetMinor" > 0)
  AND cardinality("categories") BETWEEN 1 AND 9
  AND ("claimOpensAt" IS NULL OR "claimClosesAt" IS NULL OR "claimClosesAt" > "claimOpensAt")
);

-- Exactly the stage id of the eligibility kind is set. A later kind (an
-- admission stage) replaces this constraint with its own column added.
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_stage_shape" CHECK (
  ("eligibility" = 'JUDGING_ROUND_ENTRY') = ("judgingRoundId" IS NOT NULL)
  AND ("eligibility" = 'MENTORING_ROUND') = ("mentoringRoundId" IS NOT NULL)
  AND (NOT "requireFinalistsPublished" OR "eligibility" = 'JUDGING_ROUND_ENTRY')
);

-- The stage belongs to the policy's own event.
CREATE OR REPLACE FUNCTION "reimbursement_policy_stage_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."judgingRoundId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "JudgingRound" WHERE "id" = NEW."judgingRoundId" AND "eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'Judging round belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."mentoringRoundId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "MentoringRound" WHERE "id" = NEW."mentoringRoundId" AND "eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'Mentoring round belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reimbursement_policy_stage_event"
  BEFORE INSERT OR UPDATE OF "eventId", "judgingRoundId", "mentoringRoundId" ON "ReimbursementPolicy"
  FOR EACH ROW EXECUTE FUNCTION "reimbursement_policy_stage_event"();
