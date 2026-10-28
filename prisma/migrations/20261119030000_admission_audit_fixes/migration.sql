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
