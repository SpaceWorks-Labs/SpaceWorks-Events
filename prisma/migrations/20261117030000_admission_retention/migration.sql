-- Applications keep their history (docs/ADMISSION.md "Retention").
--
-- * Deleting a registration or a team (a cancelled ticket, a full refund, an
--   organiser removal, a deleted team, an ended hold replaced, attendance
--   "No") never deletes its application: the application is WITHDRAWN and
--   detached (rsvpId/teamId SET NULL), keeping a snapshot of who applied
--   (subjectName) and the attendee keys of everyone in it (applicantKeys).
-- * One application per person per event: a registration whose attendee key
--   is already in an application of the event is refused.
-- * Registrations and teams are created pending only, and join a team only
--   while its application is still in review; a closed applicant can't join.
-- * Reviews, answer revisions, stage entries, released decisions and the
--   applications themselves are never deleted except with their event (and
--   only user-link columns may become NULL when an account is deleted).
-- * Every status or stage change of an application is recorded in
--   AdmissionStatusEvent, which the app turns into application.status_changed
--   webhooks after commit (also for changes made by triggers, such as a
--   settled payment confirming a place).

-- AlterTable
ALTER TABLE "AdmissionApplication" ADD COLUMN "applicantKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "subjectName" TEXT NOT NULL DEFAULT '';

ALTER TABLE "AdmissionAnswerRevision" ALTER COLUMN "rsvpId" DROP NOT NULL;
ALTER TABLE "AdmissionReview" ALTER COLUMN "assignmentId" DROP NOT NULL,
ALTER COLUMN "reviewerUserId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AdmissionStatusEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "AdmissionStatus" NOT NULL,
    "previousStatus" "AdmissionStatus",
    "stageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emittedAt" TIMESTAMP(3),

    CONSTRAINT "AdmissionStatusEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdmissionStatusEvent_emittedAt_createdAt_idx" ON "AdmissionStatusEvent"("emittedAt", "createdAt");
CREATE INDEX "AdmissionStatusEvent_applicationId_createdAt_idx" ON "AdmissionStatusEvent"("applicationId", "createdAt");

ALTER TABLE "AdmissionStatusEvent" ADD CONSTRAINT "AdmissionStatusEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foreign keys: registrations, teams, assignments and accounts detach instead of deleting history.
ALTER TABLE "AdmissionApplication" DROP CONSTRAINT "AdmissionApplication_rsvpId_fkey";
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdmissionApplication" DROP CONSTRAINT "AdmissionApplication_teamId_fkey";
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdmissionReview" DROP CONSTRAINT "AdmissionReview_assignmentId_fkey";
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AdmissionReviewAssignment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdmissionReview" DROP CONSTRAINT "AdmissionReview_reviewerUserId_fkey";
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdmissionAnswerRevision" DROP CONSTRAINT "AdmissionAnswerRevision_rsvpId_fkey";
ALTER TABLE "AdmissionAnswerRevision" ADD CONSTRAINT "AdmissionAnswerRevision_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A detached application is closed.
ALTER TABLE "AdmissionApplication" DROP CONSTRAINT "AdmissionApplication_shape";
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_shape" CHECK (
  num_nonnulls("rsvpId", "teamId") <= 1
  AND (num_nonnulls("rsvpId", "teamId") = 1 OR "status" IN ('REJECTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN'))
  AND "version" >= 1 AND "answersRevision" >= 1 AND "decisionRevision" >= 0
  AND ("status" <> 'OFFERED' OR "respondBy" IS NOT NULL)
  AND ("status" <> 'WAITLISTED' OR "queuedAt" IS NOT NULL)
  AND ("skipReason" IS NULL OR char_length("skipReason") <= 200)
  AND char_length("subjectName") <= 200
);

-- ---------------------------------------------------------------------------
-- Append-only, except with their event. An UPDATE may only set the listed
-- user-link columns to NULL (an account deleted); a DELETE happens only when
-- the event is gone (its cascade).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "admission_event_gone"(stage_id TEXT, application_id TEXT) RETURNS boolean AS $$
  SELECT NOT EXISTS (SELECT 1 FROM "AdmissionStage" s JOIN "Event" e ON e."id" = s."eventId" WHERE s."id" = stage_id)
     AND NOT EXISTS (SELECT 1 FROM "AdmissionApplication" a JOIN "Event" e ON e."id" = a."eventId" WHERE a."id" = application_id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION "admission_append_only"() RETURNS trigger AS $$
DECLARE
  nullable TEXT[] := TG_ARGV;
  column_name TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- An untouched application discarded when its registration created a team (see below).
    IF current_setting('admission.discard', true) = OLD."applicationId" THEN RETURN OLD; END IF;
    IF TG_TABLE_NAME = 'AdmissionAnswerRevision' THEN
      IF NOT EXISTS (SELECT 1 FROM "AdmissionApplication" a JOIN "Event" e ON e."id" = a."eventId" WHERE a."id" = OLD."applicationId") THEN RETURN OLD; END IF;
    ELSIF "admission_event_gone"(OLD."stageId", OLD."applicationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
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

DROP TRIGGER "admission_review_append_only" ON "AdmissionReview";
DROP TRIGGER "admission_answer_revision_append_only" ON "AdmissionAnswerRevision";
DROP TRIGGER "admission_stage_entry_append_only" ON "AdmissionStageEntry";
CREATE TRIGGER "admission_review_append_only" BEFORE UPDATE OR DELETE ON "AdmissionReview" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"('assignmentId', 'reviewerUserId');
CREATE TRIGGER "admission_answer_revision_append_only" BEFORE UPDATE OR DELETE ON "AdmissionAnswerRevision" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"('rsvpId');
CREATE TRIGGER "admission_stage_entry_append_only" BEFORE UPDATE OR DELETE ON "AdmissionStageEntry" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"('advancedByUserId');

-- Decisions: drafts may be replaced; released and cancelled ones stay.
CREATE OR REPLACE FUNCTION "admission_decision_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "AdmissionDecisionBatch" b WHERE b."id" = OLD."batchId" AND b."status" = 'DRAFT')
       OR "admission_event_gone"(OLD."stageId", OLD."applicationId") THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Admission decisions are append-only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'createdByUserId') IS DISTINCT FROM (to_jsonb(OLD) - 'createdByUserId') OR NEW."createdByUserId" IS NOT NULL THEN
      RAISE EXCEPTION 'Admission decisions are append-only' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "AdmissionDecisionBatch" b
    JOIN "AdmissionApplication" a ON a."eventId" = b."eventId"
    JOIN "AdmissionStage" s ON s."eventId" = b."eventId"
    WHERE b."id" = NEW."batchId" AND b."status" = 'DRAFT' AND a."id" = NEW."applicationId" AND s."id" = NEW."stageId"
  ) THEN
    RAISE EXCEPTION 'A decision is drafted into a DRAFT batch of its application''s event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "admission_decision_guard" ON "AdmissionDecision";
CREATE TRIGGER "admission_decision_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AdmissionDecision" FOR EACH ROW EXECUTE FUNCTION "admission_decision_guard"();

-- Applications go only with their event.
CREATE OR REPLACE FUNCTION "admission_application_keep"() RETURNS trigger AS $$
BEGIN
  IF current_setting('admission.discard', true) = OLD."id" THEN RETURN OLD; END IF;
  IF EXISTS (SELECT 1 FROM "Event" e WHERE e."id" = OLD."eventId") THEN
    RAISE EXCEPTION 'Applications are kept: withdraw it instead' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_application_keep" BEFORE DELETE ON "AdmissionApplication" FOR EACH ROW EXECUTE FUNCTION "admission_application_keep"();

-- ---------------------------------------------------------------------------
-- Registrations and teams.
-- ---------------------------------------------------------------------------

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
    SELECT coalesce(array_agg(r."attendeeKey"), ARRAY[]::TEXT[]) INTO keys FROM "RSVP" r WHERE r."teamId" = team_id;
  ELSE
    SELECT coalesce(nullif(btrim(u."name"), ''), nullif(btrim(r."guestName"), ''), 'Guest'), ARRAY[r."attendeeKey"] INTO subject, keys
      FROM "RSVP" r LEFT JOIN "User" u ON u."id" = r."userId" WHERE r."id" = rsvp_id;
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

-- Before a registration or team is created on an admission event: pending
-- only, one application per person, and joining only an open team application.
CREATE OR REPLACE FUNCTION "admission_registration_guard"() RETURNS trigger AS $$
DECLARE
  team_status "AdmissionStatus";
  solo_status "AdmissionStatus";
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
    IF EXISTS (SELECT 1 FROM "AdmissionApplication" a WHERE a."eventId" = NEW."eventId" AND NEW."attendeeKey" = ANY(a."applicantKeys")) THEN
      RAISE EXCEPTION 'admission_already_applied: one application per person' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."teamId" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."teamId" IS DISTINCT FROM NEW."teamId") THEN
    SELECT a."status" INTO team_status FROM "AdmissionApplication" a WHERE a."teamId" = NEW."teamId";
    IF FOUND AND team_status <> 'IN_REVIEW' THEN
      RAISE EXCEPTION 'admission_team_closed: this team''s application has been decided' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      SELECT a."status" INTO solo_status FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id";
      IF FOUND AND solo_status NOT IN ('IN_REVIEW', 'WAITLISTED') THEN
        RAISE EXCEPTION 'admission_team_closed: this application is closed or holds an offer' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_registration_guard" BEFORE INSERT OR UPDATE OF "teamId" ON "RSVP" FOR EACH ROW EXECUTE FUNCTION "admission_registration_guard"();
CREATE TRIGGER "team_admission_registration_guard" BEFORE INSERT ON "Team" FOR EACH ROW EXECUTE FUNCTION "admission_registration_guard"();

CREATE OR REPLACE FUNCTION "rsvp_admission_application"() RETURNS trigger AS $$
DECLARE
  untouched TEXT;
BEGIN
  IF NEW."eventId" IS NULL OR NEW."isCrew" THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."teamId" IS NULL THEN PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status"); END IF;
  ELSIF OLD."teamId" IS NULL AND NEW."teamId" IS NOT NULL THEN
    -- A solo registrant joined (or is creating) a team: the team's application
    -- covers them now. An application made moments ago that nobody touched
    -- (a leader's registration placed just before its team) is discarded;
    -- any other is kept as WITHDRAWN.
    SELECT a."id" INTO untouched FROM "AdmissionApplication" a
      WHERE a."rsvpId" = NEW."id" AND a."status" = 'IN_REVIEW' AND a."version" = 1 AND a."decisionRevision" = 0
        AND NOT EXISTS (SELECT 1 FROM "AdmissionReview" x WHERE x."applicationId" = a."id")
        AND NOT EXISTS (SELECT 1 FROM "AdmissionDecision" x WHERE x."applicationId" = a."id")
        AND NOT EXISTS (SELECT 1 FROM "AdmissionAnswerRevision" x WHERE x."applicationId" = a."id");
    IF FOUND THEN
      PERFORM set_config('admission.discard', untouched, true);
      DELETE FROM "AdmissionApplication" WHERE "id" = untouched;
      PERFORM set_config('admission.discard', '', true);
    END IF;
    UPDATE "AdmissionApplication" SET "status" = 'WITHDRAWN', "version" = "version" + 1, "queuedAt" = NULL,
      "updatedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "rsvpId" = NEW."id" AND "status" IN ('IN_REVIEW', 'WAITLISTED');
  ELSIF OLD."teamId" IS NOT NULL AND NEW."teamId" IS NULL THEN
    PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status");
  END IF;
  -- Everyone who was ever in a team application is one of its applicants.
  IF NEW."teamId" IS NOT NULL THEN
    UPDATE "AdmissionApplication" SET "applicantKeys" = array_append("applicantKeys", NEW."attendeeKey")
      WHERE "teamId" = NEW."teamId" AND NOT (NEW."attendeeKey" = ANY("applicantKeys"));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A deleted registration or team withdraws (and detaches) its application.
CREATE OR REPLACE FUNCTION "admission_withdraw_on_delete"() RETURNS trigger AS $$
BEGIN
  UPDATE "AdmissionApplication"
    SET "status" = CASE WHEN "status" IN ('REJECTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN') THEN "status" ELSE 'WITHDRAWN'::"AdmissionStatus" END,
        "queuedAt" = NULL, "version" = "version" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3)
    WHERE CASE WHEN TG_TABLE_NAME = 'Team' THEN "teamId" = OLD."id" ELSE "rsvpId" = OLD."id" END;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_withdraw" BEFORE DELETE ON "RSVP" FOR EACH ROW EXECUTE FUNCTION "admission_withdraw_on_delete"();
CREATE TRIGGER "team_admission_withdraw" BEFORE DELETE ON "Team" FOR EACH ROW EXECUTE FUNCTION "admission_withdraw_on_delete"();

-- Status history: every status or stage change, for webhooks after commit.
CREATE OR REPLACE FUNCTION "admission_status_event"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."currentStageId" IS DISTINCT FROM OLD."currentStageId" THEN
    INSERT INTO "AdmissionStatusEvent" ("id", "applicationId", "eventId", "status", "previousStatus", "stageId", "createdAt")
    VALUES (gen_random_uuid()::text, NEW."id", NEW."eventId", NEW."status", OLD."status", NEW."currentStageId", (now() AT TIME ZONE 'UTC')::timestamp(3));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_status_event" AFTER UPDATE OF "status", "currentStageId" ON "AdmissionApplication" FOR EACH ROW EXECUTE FUNCTION "admission_status_event"();

-- Backfill the snapshots of existing applications.
UPDATE "AdmissionApplication" a SET "subjectName" = left(coalesce(nullif(btrim(u."name"), ''), nullif(btrim(r."guestName"), ''), 'Guest'), 200), "applicantKeys" = ARRAY[r."attendeeKey"]
  FROM "RSVP" r LEFT JOIN "User" u ON u."id" = r."userId" WHERE a."rsvpId" = r."id";
UPDATE "AdmissionApplication" a SET "subjectName" = left(t."name", 200), "applicantKeys" = coalesce((SELECT array_agg(r."attendeeKey") FROM "RSVP" r WHERE r."teamId" = t."id"), ARRAY[]::TEXT[])
  FROM "Team" t WHERE a."teamId" = t."id";
