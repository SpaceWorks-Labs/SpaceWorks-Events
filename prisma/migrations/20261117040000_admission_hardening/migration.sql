-- Applications hardening (docs/ADMISSION.md "Retention", "One application per person").
--
-- * applicantKeys hold one-way hashes ('h:' + SHA-256 hex) of every key a
--   person is known by: the registration's attendee key, the account's
--   verified email and the guest email (each as 'guest:<lower-cased email>'),
--   so the one-per-person rule can't be dodged by registering once as a guest
--   and once with an account, and no email is kept in clear.
-- * Leaving a team (or a team deleted around its members): a member keeps a
--   pending place only when the team's application is still in review and
--   nobody else's application holds them; they then get a solo application.
--   Otherwise the registration is declined (REJECTED) and no application opens.
-- * Joining a team: only an untouched solo application (in review, never
--   reviewed, decided, edited or otherwise changed) moves into a team.
-- * Deleting an account scrubs the snapshot name of its applications and
--   redacts its answer revisions to their questions (the hashed keys stay, so
--   the one-per-person rule still holds).
-- * Status events: a partial index on what is still to send.

CREATE OR REPLACE FUNCTION "admission_key_hash"(raw TEXT) RETURNS TEXT AS $$
  SELECT 'h:' || encode(sha256(convert_to(raw, 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- Every hashed key of one person: the attendee key, and their email(s) as guest keys.
CREATE OR REPLACE FUNCTION "admission_person_keys"(attendee_key TEXT, user_id TEXT, guest_email TEXT) RETURNS TEXT[] AS $$
DECLARE
  keys TEXT[] := ARRAY["admission_key_hash"(attendee_key)];
  account_email TEXT;
BEGIN
  IF user_id IS NOT NULL THEN
    SELECT lower(btrim(u."email")) INTO account_email FROM "User" u WHERE u."id" = user_id AND u."emailVerified" IS NOT NULL;
    IF account_email IS NOT NULL AND account_email <> '' THEN keys := keys || "admission_key_hash"('guest:' || account_email); END IF;
  END IF;
  IF guest_email IS NOT NULL AND btrim(guest_email) <> '' THEN keys := keys || "admission_key_hash"('guest:' || lower(btrim(guest_email))); END IF;
  RETURN ARRAY(SELECT DISTINCT unnest(keys));
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION "admission_rsvp_keys"(rsvp_id TEXT) RETURNS TEXT[] AS $$
  SELECT coalesce("admission_person_keys"(r."attendeeKey", r."userId", r."guestEmail"), ARRAY[]::TEXT[]) FROM "RSVP" r WHERE r."id" = rsvp_id;
$$ LANGUAGE sql STABLE;

-- Whose answers a revision holds, as a hashed person key, kept when the registration goes.
ALTER TABLE "AdmissionAnswerRevision" ADD COLUMN "personKey" TEXT;
ALTER TABLE "AdmissionAnswerRevision" ADD CONSTRAINT "AdmissionAnswerRevision_person_key_shape" CHECK ("personKey" IS NULL OR "personKey" ~ '^h:[0-9a-f]{64}$');

-- Existing keys become hashes (clear keys never start with 'h:').
UPDATE "AdmissionApplication" SET "applicantKeys" = ARRAY(SELECT "admission_key_hash"(k) FROM unnest("applicantKeys") k)
  WHERE EXISTS (SELECT 1 FROM unnest("applicantKeys") k WHERE k NOT LIKE 'h:%');
UPDATE "AdmissionApplication" a SET "applicantKeys" = ARRAY(SELECT DISTINCT unnest(a."applicantKeys" || "admission_rsvp_keys"(a."rsvpId")))
  WHERE a."rsvpId" IS NOT NULL;
UPDATE "AdmissionAnswerRevision" v SET "personKey" = "admission_key_hash"(r."attendeeKey") FROM "RSVP" r WHERE v."rsvpId" = r."id" AND v."personKey" IS NULL;

CREATE OR REPLACE FUNCTION "admission_open_application"(event_id TEXT, rsvp_id TEXT, team_id TEXT, registration_status "RsvpStatus") RETURNS void AS $$
DECLARE
  first_stage TEXT;
  application_id TEXT := gen_random_uuid()::text;
  now_utc TIMESTAMP(3) := (now() AT TIME ZONE 'UTC')::timestamp(3);
  subject TEXT;
  keys TEXT[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = event_id AND e."admissionEnabled") THEN RETURN; END IF;
  SELECT s."id" INTO first_stage FROM "AdmissionStage" s WHERE s."eventId" = event_id AND s."position" = 1;
  IF team_id IS NOT NULL THEN
    SELECT t."name" INTO subject FROM "Team" t WHERE t."id" = team_id;
    SELECT coalesce(array_agg(DISTINCT k), ARRAY[]::TEXT[]) INTO keys FROM "RSVP" r, unnest("admission_rsvp_keys"(r."id")) k WHERE r."teamId" = team_id;
  ELSE
    SELECT coalesce(nullif(btrim(u."name"), ''), nullif(btrim(r."guestName"), ''), 'Guest') INTO subject
      FROM "RSVP" r LEFT JOIN "User" u ON u."id" = r."userId" WHERE r."id" = rsvp_id;
    keys := "admission_rsvp_keys"(rsvp_id);
  END IF;
  INSERT INTO "AdmissionApplication" ("id", "eventId", "rsvpId", "teamId", "status", "currentStageId", "submittedAt", "createdAt", "updatedAt", "subjectName", "applicantKeys")
  VALUES (application_id, event_id, rsvp_id, team_id, 'IN_REVIEW', first_stage, now_utc, now_utc, now_utc, left(coalesce(subject, ''), 200), coalesce(keys, ARRAY[]::TEXT[]))
  ON CONFLICT DO NOTHING;
  IF FOUND AND first_stage IS NOT NULL THEN
    INSERT INTO "AdmissionStageEntry" ("id", "stageId", "applicationId", "source", "advancedAt")
    VALUES (gen_random_uuid()::text, first_stage, application_id, 'ALL', now_utc);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- An application nobody has touched yet: in review, never changed, reviewed, decided or edited.
CREATE OR REPLACE FUNCTION "admission_untouched"(application_id TEXT) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM "AdmissionApplication" a
    WHERE a."id" = application_id AND a."status" = 'IN_REVIEW' AND a."version" = 1 AND a."decisionRevision" = 0
      AND NOT EXISTS (SELECT 1 FROM "AdmissionReview" x WHERE x."applicationId" = a."id")
      AND NOT EXISTS (SELECT 1 FROM "AdmissionDecision" x WHERE x."applicationId" = a."id")
      AND NOT EXISTS (SELECT 1 FROM "AdmissionAnswerRevision" x WHERE x."applicationId" = a."id")
  );
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "admission_registration_guard"() RETURNS trigger AS $$
DECLARE
  team_status "AdmissionStatus";
  team_application TEXT;
  solo TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Team' THEN
    IF NEW."status" <> 'PENDING_APPROVAL' AND EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = NEW."eventId" AND e."admissionEnabled") THEN
      RAISE EXCEPTION 'admission_review_required: a team applies before it has a place' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."eventId" IS NULL OR NEW."isCrew" OR NOT EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = NEW."eventId" AND e."admissionEnabled") THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_APPROVAL' THEN
      RAISE EXCEPTION 'admission_review_required: a registration applies before it has a place' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "AdmissionApplication" a WHERE a."eventId" = NEW."eventId" AND a."applicantKeys" && "admission_person_keys"(NEW."attendeeKey", NEW."userId", NEW."guestEmail")) THEN
      RAISE EXCEPTION 'admission_already_applied: one application per person' USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Joining a team (a new member, or a solo registrant moving in).
  IF NEW."teamId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."teamId" IS DISTINCT FROM NEW."teamId") THEN
    SELECT a."status" INTO team_status FROM "AdmissionApplication" a WHERE a."teamId" = NEW."teamId";
    IF FOUND AND team_status <> 'IN_REVIEW' THEN
      RAISE EXCEPTION 'admission_team_closed: this team''s application has been decided' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT a."id" INTO solo FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id";
      IF FOUND AND NOT "admission_untouched"(solo) THEN
        RAISE EXCEPTION 'admission_team_closed: an application already reviewed or decided can''t move into a team' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  -- Leaving a team (or the team deleted around them): a pending place stays
  -- only while the team's application is in review and nobody else's
  -- application holds this person; otherwise the place is declined.
  IF TG_OP = 'UPDATE' AND OLD."teamId" IS NOT NULL AND NEW."teamId" IS NULL THEN
    SELECT a."id", a."status" INTO team_application, team_status FROM "AdmissionApplication" a WHERE a."teamId" = OLD."teamId";
    IF NOT FOUND OR team_status <> 'IN_REVIEW' OR NEW."status" <> 'PENDING_APPROVAL'
       OR EXISTS (SELECT 1 FROM "AdmissionApplication" a WHERE a."eventId" = NEW."eventId" AND a."id" <> team_application
                    AND a."applicantKeys" && "admission_person_keys"(NEW."attendeeKey", NEW."userId", NEW."guestEmail")) THEN
      NEW."status" := 'REJECTED';
      NEW."holdExpiresAt" := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "rsvp_admission_application"() RETURNS trigger AS $$
DECLARE
  untouched TEXT;
BEGIN
  IF NEW."eventId" IS NULL OR NEW."isCrew" THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."teamId" IS NULL THEN PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status"); END IF;
  ELSIF OLD."teamId" IS NULL AND NEW."teamId" IS NOT NULL THEN
    -- Only an untouched solo application moves into a team (the guard refuses
    -- any other): it is discarded, and the team's application covers them.
    SELECT a."id" INTO untouched FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id";
    IF FOUND THEN
      PERFORM set_config('admission.discard', untouched, true);
      DELETE FROM "AdmissionApplication" WHERE "id" = untouched;
      PERFORM set_config('admission.discard', '', true);
    END IF;
  ELSIF OLD."teamId" IS NOT NULL AND NEW."teamId" IS NULL THEN
    IF NEW."status" = 'PENDING_APPROVAL' THEN
      -- They left a team still in review: they apply on their own now.
      UPDATE "AdmissionApplication" SET "applicantKeys" = ARRAY(SELECT k FROM unnest("applicantKeys") k WHERE k <> ALL ("admission_rsvp_keys"(NEW."id")))
        WHERE "teamId" = OLD."teamId";
      PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status");
    END IF;
  END IF;
  -- Everyone who was ever in a team application is one of its applicants.
  IF NEW."teamId" IS NOT NULL THEN
    UPDATE "AdmissionApplication" SET "applicantKeys" = ARRAY(SELECT DISTINCT unnest("applicantKeys" || "admission_rsvp_keys"(NEW."id")))
      WHERE "teamId" = NEW."teamId" AND NOT ("applicantKeys" @> "admission_rsvp_keys"(NEW."id"));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Plain indexed updates, one branch per table.
CREATE OR REPLACE FUNCTION "admission_withdraw_on_delete"() RETURNS trigger AS $$
DECLARE
  now_utc TIMESTAMP(3) := (now() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF TG_TABLE_NAME = 'Team' THEN
    UPDATE "AdmissionApplication" SET "status" = 'WITHDRAWN', "queuedAt" = NULL, "version" = "version" + 1, "updatedAt" = now_utc
      WHERE "teamId" = OLD."id" AND "status" NOT IN ('REJECTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');
  ELSE
    UPDATE "AdmissionApplication" SET "status" = 'WITHDRAWN', "queuedAt" = NULL, "version" = "version" + 1, "updatedAt" = now_utc
      WHERE "rsvpId" = OLD."id" AND "status" NOT IN ('REJECTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "admission_accept_on_confirm"() RETURNS trigger AS $$
DECLARE
  now_utc TIMESTAMP(3) := (now() AT TIME ZONE 'UTC')::timestamp(3);
BEGIN
  IF NEW."status" = 'CONFIRMED' AND OLD."status" IS DISTINCT FROM 'CONFIRMED' THEN
    IF TG_TABLE_NAME = 'Team' THEN
      UPDATE "AdmissionApplication" SET "status" = 'ACCEPTED', "version" = "version" + 1, "updatedAt" = now_utc WHERE "teamId" = NEW."id" AND "status" = 'OFFERED';
    ELSE
      UPDATE "AdmissionApplication" SET "status" = 'ACCEPTED', "version" = "version" + 1, "updatedAt" = now_utc WHERE "rsvpId" = NEW."id" AND "status" = 'OFFERED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Answer revisions may be redacted (account deletion), and only that way.
CREATE OR REPLACE FUNCTION "admission_append_only"() RETURNS trigger AS $$
DECLARE
  nullable TEXT[] := TG_ARGV;
  column_name TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('admission.discard', true) = OLD."applicationId" THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME = 'AdmissionAnswerRevision' THEN
      IF NOT EXISTS (SELECT 1 FROM "AdmissionApplication" a JOIN "Event" e ON e."id" = a."eventId" WHERE a."id" = OLD."applicationId") THEN RETURN OLD; END IF;
    ELSIF "admission_event_gone"(OLD."stageId", OLD."applicationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'AdmissionAnswerRevision' AND current_setting('admission.redact', true) = 'on'
     AND (to_jsonb(NEW) - 'answers' - 'rsvpId') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'answers' - 'rsvpId') THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - nullable) IS DISTINCT FROM (to_jsonb(OLD) - nullable) THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  FOREACH column_name IN ARRAY nullable LOOP
    IF (to_jsonb(NEW) -> column_name) IS DISTINCT FROM (to_jsonb(OLD) -> column_name) AND (to_jsonb(NEW) -> column_name) <> 'null'::jsonb THEN
      RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Deleting an account: scrub what its applications kept about the person.
CREATE OR REPLACE FUNCTION "admission_scrub_account"() RETURNS trigger AS $$
DECLARE
  keys TEXT[] := ARRAY["admission_key_hash"('user:' || OLD."id")];
BEGIN
  IF OLD."email" IS NOT NULL AND btrim(OLD."email") <> '' THEN keys := keys || "admission_key_hash"('guest:' || lower(btrim(OLD."email"))); END IF;
  UPDATE "AdmissionApplication" SET "subjectName" = '' WHERE "rsvpId" IS NULL AND "teamId" IS NULL AND "applicantKeys" && keys;
  UPDATE "AdmissionApplication" a SET "subjectName" = '' WHERE a."rsvpId" IN (SELECT r."id" FROM "RSVP" r WHERE r."userId" = OLD."id");
  PERFORM set_config('admission.redact', 'on', true);
  UPDATE "AdmissionAnswerRevision" v
    SET "answers" = coalesce((SELECT jsonb_agg(jsonb_build_object('fieldId', x -> 'fieldId', 'label', x -> 'label')) FROM jsonb_array_elements(v."answers") x), '[]'::jsonb)
    WHERE v."rsvpId" IN (SELECT r."id" FROM "RSVP" r WHERE r."userId" = OLD."id") OR v."personKey" = ANY(keys);
  PERFORM set_config('admission.redact', '', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "user_admission_scrub" BEFORE DELETE ON "User" FOR EACH ROW EXECUTE FUNCTION "admission_scrub_account"();

-- What is still to send, and nothing else, in the status events index.
DROP INDEX "AdmissionStatusEvent_emittedAt_createdAt_idx";
CREATE INDEX "AdmissionStatusEvent_unsent_idx" ON "AdmissionStatusEvent"("createdAt") WHERE "emittedAt" IS NULL;
