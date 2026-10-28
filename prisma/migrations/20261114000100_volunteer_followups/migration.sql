-- Volunteer shifts follow-up (docs/VOLUNTEERS.md): new hours rows must be
-- exactly what check-out records. `volunteer_hours_guard` now also runs on
-- INSERT: the row starts PENDING at version 0 for a checked-out sign-up of
-- the same event, with minutes equal to that attendance's counted minutes
-- (whole minutes between check-in and check-out, less breaks).

CREATE OR REPLACE FUNCTION "volunteer_hours_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  counted INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT FLOOR(EXTRACT(EPOCH FROM (s."checkedOutAt" - s."checkedInAt")) / 60)::INTEGER - s."breakMinutes"
      INTO counted
      FROM "VolunteerShiftSignup" s
      WHERE s."id" = NEW."signupId" AND s."eventId" = NEW."eventId" AND s."attendance" = 'CHECKED_OUT';
    IF counted IS NULL OR NEW."state" <> 'PENDING' OR NEW."version" <> 0 OR NEW."minutes" <> counted THEN
      RAISE EXCEPTION 'Volunteer hours start pending with the attendance''s counted minutes' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "VolunteerShiftSignup" WHERE "id" = OLD."signupId") THEN
      RAISE EXCEPTION 'Volunteer hours are deleted only with their sign-up' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."signupId" <> OLD."signupId" OR NEW."eventId" <> OLD."eventId" THEN
    RAISE EXCEPTION 'Volunteer hours cannot move' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."minutes", NEW."state", NEW."version") IS DISTINCT FROM (OLD."minutes", OLD."state", OLD."version") THEN
    IF NEW."version" <> OLD."version" + 1 OR NEW."state" = 'PENDING' OR NOT EXISTS (
      SELECT 1 FROM "VolunteerHoursEntry" e
      WHERE e."hoursId" = NEW."id" AND e."previousVersion" = OLD."version"
        AND e."minutes" = NEW."minutes" AND e."kind"::text = NEW."state"::text
    ) THEN
      RAISE EXCEPTION 'Volunteer hours change only through a verification entry' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "volunteer_hours_guard" ON "VolunteerHours";
CREATE TRIGGER "volunteer_hours_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "VolunteerHours"
  FOR EACH ROW EXECUTE FUNCTION "volunteer_hours_guard"();
