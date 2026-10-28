-- Admission audit fixes (docs/ADMISSION.md, docs/CREW.md#applicants).
--
-- * A registration becomes a crew ticket only once its application is
--   detached (lib/core/crew/application.ts): a crew ticket never accepts an
--   offer, holds one, or stays an application.

CREATE OR REPLACE FUNCTION "admission_crew_detached"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id") THEN
    RAISE EXCEPTION 'admission_crew_application: detach the application before the registration becomes crew' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_crew_detached"
  BEFORE UPDATE OF "isCrew" ON "RSVP"
  FOR EACH ROW WHEN (NEW."isCrew" AND NOT OLD."isCrew")
  EXECUTE FUNCTION "admission_crew_detached"();

-- * ADMISSION_STAGE reimbursement policies pay ACCEPTED applicants only
--   (docs/FINANCE.md), so the requireAccepted option goes. It arrived in this
--   same release (20261118050000), so no released build reads it.
ALTER TABLE "ReimbursementPolicy" DROP CONSTRAINT "ReimbursementPolicy_stage_shape";
ALTER TABLE "ReimbursementPolicy" DROP COLUMN "requireAccepted";
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_stage_shape" CHECK (
  ("eligibility" = 'JUDGING_ROUND_ENTRY') = ("judgingRoundId" IS NOT NULL)
  AND ("eligibility" = 'MENTORING_ROUND') = ("mentoringRoundId" IS NOT NULL)
  AND ("eligibility" = 'ADMISSION_STAGE') = ("admissionStageId" IS NOT NULL)
  AND (NOT "requireFinalistsPublished" OR "eligibility" = 'JUDGING_ROUND_ENTRY')
);
