-- ADMISSION_STAGE policies name the admission stage applicants must reach,
-- and may require an accepted application.
ALTER TABLE "ReimbursementPolicy" ADD COLUMN "admissionStageId" TEXT,
ADD COLUMN "requireAccepted" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "ReimbursementPolicy_admissionStageId_idx" ON "ReimbursementPolicy"("admissionStageId");

-- AddForeignKey: NO ACTION, so a stage a policy is for can't be deleted on
-- its own, while deleting the whole event still works.
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_admissionStageId_fkey" FOREIGN KEY ("admissionStageId") REFERENCES "AdmissionStage"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Exactly the stage id of the eligibility kind is set.
ALTER TABLE "ReimbursementPolicy" DROP CONSTRAINT "ReimbursementPolicy_stage_shape";
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_stage_shape" CHECK (
  ("eligibility" = 'JUDGING_ROUND_ENTRY') = ("judgingRoundId" IS NOT NULL)
  AND ("eligibility" = 'MENTORING_ROUND') = ("mentoringRoundId" IS NOT NULL)
  AND ("eligibility" = 'ADMISSION_STAGE') = ("admissionStageId" IS NOT NULL)
  AND (NOT "requireFinalistsPublished" OR "eligibility" = 'JUDGING_ROUND_ENTRY')
  AND (NOT "requireAccepted" OR "eligibility" = 'ADMISSION_STAGE')
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
  IF NEW."admissionStageId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "AdmissionStage" WHERE "id" = NEW."admissionStageId" AND "eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'Admission stage belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "reimbursement_policy_stage_event" ON "ReimbursementPolicy";
CREATE TRIGGER "reimbursement_policy_stage_event"
  BEFORE INSERT OR UPDATE OF "eventId", "judgingRoundId", "mentoringRoundId", "admissionStageId" ON "ReimbursementPolicy"
  FOR EACH ROW EXECUTE FUNCTION "reimbursement_policy_stage_event"();
