-- Applications and shortlisting (docs/ADMISSION.md): the database guards.
--
-- * CHECKs on the shape of each table, and one DRAFT decision batch per event.
-- * Applications are made by triggers when a registration (a solo RSVP or a
--   team) is created on an admission event, so no registration path can skip
--   review. A crew ticket never becomes an application.
-- * A registration (or team) on an admission event may become CONFIRMED or
--   PENDING_PAYMENT only while its application is OFFERED or ACCEPTED: an
--   application in review or on the waitlist can't be confirmed by any older
--   approve, promote or waitlist path. Confirming an OFFERED application's
--   registration (a settled payment) marks the application ACCEPTED.
-- * Reviews, answer revisions, stage entries and released decisions are
--   append-only; every stage-linked row stays on its application's event.
-- Timestamps written here are UTC wall-clock, like Prisma's.

ALTER TABLE "Event" ADD CONSTRAINT "Event_admission_shape" CHECK (
  "admissionRsvpDays" BETWEEN 1 AND 30
  AND ("admissionOfferCapacity" IS NULL OR "admissionOfferCapacity" >= 1)
  AND (NOT "admissionEnabled" OR "privacyType" = 'APPROVAL_REQUIRED')
);

ALTER TABLE "AdmissionStage" ADD CONSTRAINT "AdmissionStage_shape" CHECK (
  char_length(btrim("name")) BETWEEN 1 AND 80
  AND "position" >= 1
  AND "reviewsPerApplication" BETWEEN 1 AND 20
  AND coalesce(array_length("criteria", 1), 0) <= 10
  AND char_length("guidance") <= 2000
  AND ("opensAt" IS NULL OR "closesAt" IS NULL OR "closesAt" > "opensAt")
);

ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_shape" CHECK (
  num_nonnulls("rsvpId", "teamId") = 1
  AND "version" >= 1 AND "answersRevision" >= 1 AND "decisionRevision" >= 0
  AND ("status" <> 'OFFERED' OR "respondBy" IS NOT NULL)
  AND ("status" <> 'WAITLISTED' OR "queuedAt" IS NOT NULL)
  AND ("skipReason" IS NULL OR char_length("skipReason") <= 200)
);

ALTER TABLE "AdmissionStageEntry" ADD CONSTRAINT "AdmissionStageEntry_shape" CHECK ("sourceRank" IS NULL OR "sourceRank" >= 1);

ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_shape" CHECK (
  jsonb_typeof("scores") = 'object' AND char_length("notes") <= 2000 AND "answersRevision" >= 1
);

ALTER TABLE "AdmissionReviewConflict" ADD CONSTRAINT "AdmissionReviewConflict_known_reason" CHECK ("reason" IN ('declared', 'organiser'));

ALTER TABLE "AdmissionAssignmentRun" ADD CONSTRAINT "AdmissionAssignmentRun_shape" CHECK (
  "mode" IN ('keep', 'replace')
  AND (("strategy" = 'RANDOM') = ("seed" IS NOT NULL))
  AND ("seed" IS NULL OR "seed" ~ '^[0-9a-f]{32}$')
  AND "perApplication" BETWEEN 1 AND 20
  AND "reviewers" >= 0 AND "added" >= 0 AND "removed" >= 0
);

ALTER TABLE "AdmissionDecision" ADD CONSTRAINT "AdmissionDecision_shape" CHECK (
  "expectedVersion" >= 1
  AND char_length("note") <= 200
  AND ("overrideReason" IS NULL OR char_length(btrim("overrideReason")) BETWEEN 1 AND 500)
  AND ("sourceRank" IS NULL OR "sourceRank" >= 1)
);

CREATE UNIQUE INDEX "AdmissionDecisionBatch_one_draft_per_event" ON "AdmissionDecisionBatch"("eventId") WHERE "status" = 'DRAFT';

-- ---------------------------------------------------------------------------
-- Every stage-linked row stays on its application's event.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "admission_application_shape"() RETURNS trigger AS $$
BEGIN
  IF NEW."rsvpId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "RSVP" r WHERE r."id" = NEW."rsvpId" AND r."eventId" = NEW."eventId" AND NOT r."isCrew"
  ) THEN
    RAISE EXCEPTION 'An application must be a registration of its event, never a crew ticket' USING ERRCODE = '23514';
  END IF;
  IF NEW."teamId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Team" t WHERE t."id" = NEW."teamId" AND t."eventId" = NEW."eventId") THEN
    RAISE EXCEPTION 'An application must be a team of its event' USING ERRCODE = '23514';
  END IF;
  IF NEW."currentStageId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdmissionStage" s WHERE s."id" = NEW."currentStageId" AND s."eventId" = NEW."eventId") THEN
    RAISE EXCEPTION 'An application stage must be on its event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_application_shape"
  BEFORE INSERT OR UPDATE OF "eventId", "rsvpId", "teamId", "currentStageId" ON "AdmissionApplication"
  FOR EACH ROW EXECUTE FUNCTION "admission_application_shape"();

CREATE OR REPLACE FUNCTION "admission_same_event"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AdmissionStage" s JOIN "AdmissionApplication" a ON a."eventId" = s."eventId"
    WHERE s."id" = NEW."stageId" AND a."id" = NEW."applicationId"
  ) THEN
    RAISE EXCEPTION 'An admission stage and application must be on the same event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_stage_entry_event" BEFORE INSERT ON "AdmissionStageEntry" FOR EACH ROW EXECUTE FUNCTION "admission_same_event"();
CREATE TRIGGER "admission_assignment_event" BEFORE INSERT OR UPDATE OF "stageId", "applicationId" ON "AdmissionReviewAssignment" FOR EACH ROW EXECUTE FUNCTION "admission_same_event"();
CREATE TRIGGER "admission_review_event" BEFORE INSERT ON "AdmissionReview" FOR EACH ROW EXECUTE FUNCTION "admission_same_event"();

CREATE OR REPLACE FUNCTION "admission_decision_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Admission decisions are append-only' USING ERRCODE = '23514';
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

CREATE TRIGGER "admission_decision_guard" BEFORE INSERT OR UPDATE ON "AdmissionDecision" FOR EACH ROW EXECUTE FUNCTION "admission_decision_guard"();

CREATE OR REPLACE FUNCTION "admission_conflict_event"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AdmissionApplication" a WHERE a."id" = NEW."applicationId" AND a."eventId" = NEW."eventId") THEN
    RAISE EXCEPTION 'A review conflict must be on its application''s event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_conflict_event" BEFORE INSERT OR UPDATE ON "AdmissionReviewConflict" FOR EACH ROW EXECUTE FUNCTION "admission_conflict_event"();

-- Append-only records.
CREATE OR REPLACE FUNCTION "admission_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "admission_review_append_only" BEFORE UPDATE ON "AdmissionReview" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"();
CREATE TRIGGER "admission_answer_revision_append_only" BEFORE UPDATE ON "AdmissionAnswerRevision" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"();
CREATE TRIGGER "admission_stage_entry_append_only" BEFORE UPDATE ON "AdmissionStageEntry" FOR EACH ROW EXECUTE FUNCTION "admission_append_only"();

-- ---------------------------------------------------------------------------
-- Applications are made with their registrations.
-- ---------------------------------------------------------------------------

-- Make (or keep) the application of a solo RSVP or a team, in the state its
-- registration is in, entered into the event's first stage.
CREATE OR REPLACE FUNCTION "admission_open_application"(event_id TEXT, rsvp_id TEXT, team_id TEXT, registration_status "RsvpStatus") RETURNS void AS $$
DECLARE
  first_stage TEXT;
  application_id TEXT := gen_random_uuid()::text;
  rsvp_days INTEGER;
  now_utc TIMESTAMP(3) := (now() AT TIME ZONE 'UTC')::timestamp(3);
  mapped "AdmissionStatus";
BEGIN
  SELECT e."admissionRsvpDays" INTO rsvp_days FROM "Event" e WHERE e."id" = event_id AND e."admissionEnabled";
  IF NOT FOUND THEN RETURN; END IF;
  SELECT s."id" INTO first_stage FROM "AdmissionStage" s WHERE s."eventId" = event_id AND s."position" = 1;
  mapped := CASE registration_status
    WHEN 'CONFIRMED' THEN 'ACCEPTED'::"AdmissionStatus"
    WHEN 'PENDING_PAYMENT' THEN 'OFFERED'::"AdmissionStatus"
    WHEN 'WAITLISTED' THEN 'WAITLISTED'::"AdmissionStatus"
    WHEN 'REJECTED' THEN 'WITHDRAWN'::"AdmissionStatus"
    ELSE 'IN_REVIEW'::"AdmissionStatus" END;
  INSERT INTO "AdmissionApplication" ("id", "eventId", "rsvpId", "teamId", "status", "currentStageId", "submittedAt", "offeredAt", "respondBy", "queuedAt", "createdAt", "updatedAt")
  VALUES (application_id, event_id, rsvp_id, team_id, mapped, first_stage, now_utc,
    CASE WHEN mapped = 'OFFERED' THEN now_utc END,
    CASE WHEN mapped = 'OFFERED' THEN now_utc + make_interval(days => rsvp_days) END,
    CASE WHEN mapped = 'WAITLISTED' THEN now_utc END,
    now_utc, now_utc)
  ON CONFLICT DO NOTHING;
  IF FOUND AND first_stage IS NOT NULL THEN
    INSERT INTO "AdmissionStageEntry" ("id", "stageId", "applicationId", "source", "advancedAt")
    VALUES (gen_random_uuid()::text, first_stage, application_id, 'ALL', now_utc);
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION "rsvp_admission_application"() RETURNS trigger AS $$
DECLARE
  solo RECORD;
BEGIN
  IF NEW."eventId" IS NULL OR NEW."isCrew" THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."teamId" IS NULL THEN PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status"); END IF;
    RETURN NEW;
  END IF;
  IF OLD."teamId" IS NULL AND NEW."teamId" IS NOT NULL THEN
    -- A solo registrant joined (or is creating) a team: the team's application
    -- covers them now. An untouched solo application goes; one with reviews
    -- or decisions is kept as WITHDRAWN.
    SELECT a."id", a."status" INTO solo FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id";
    IF FOUND THEN
      IF solo."status" IN ('OFFERED', 'ACCEPTED') THEN
        RAISE EXCEPTION 'An applicant with an offer can''t join a team' USING ERRCODE = '23514';
      END IF;
      DELETE FROM "AdmissionApplication" a WHERE a."id" = solo."id" AND a."status" = 'IN_REVIEW'
        AND NOT EXISTS (SELECT 1 FROM "AdmissionReview" r WHERE r."applicationId" = a."id")
        AND NOT EXISTS (SELECT 1 FROM "AdmissionDecision" d WHERE d."applicationId" = a."id");
      UPDATE "AdmissionApplication" SET "status" = 'WITHDRAWN', "version" = "version" + 1, "queuedAt" = NULL,
        "updatedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3)
        WHERE "id" = solo."id" AND "status" IN ('IN_REVIEW', 'WAITLISTED');
    END IF;
  ELSIF OLD."teamId" IS NOT NULL AND NEW."teamId" IS NULL THEN
    -- Left a team and stays registered on their own.
    PERFORM "admission_open_application"(NEW."eventId", NEW."id", NULL, NEW."status");
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_application"
  AFTER INSERT OR UPDATE OF "teamId" ON "RSVP"
  FOR EACH ROW EXECUTE FUNCTION "rsvp_admission_application"();

CREATE OR REPLACE FUNCTION "team_admission_application"() RETURNS trigger AS $$
BEGIN
  PERFORM "admission_open_application"(NEW."eventId", NULL, NEW."id", NEW."status");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "team_admission_application" AFTER INSERT ON "Team" FOR EACH ROW EXECUTE FUNCTION "team_admission_application"();

-- ---------------------------------------------------------------------------
-- A place is confirmed (or held for payment) only through an offer.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "admission_status_guard"() RETURNS trigger AS $$
DECLARE
  application_status "AdmissionStatus";
BEGIN
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" NOT IN ('CONFIRMED', 'PENDING_PAYMENT') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'Team' THEN
    SELECT a."status" INTO application_status FROM "AdmissionApplication" a WHERE a."teamId" = NEW."id";
  ELSIF NEW."teamId" IS NOT NULL THEN
    SELECT a."status" INTO application_status FROM "AdmissionApplication" a WHERE a."teamId" = NEW."teamId";
  ELSE
    SELECT a."status" INTO application_status FROM "AdmissionApplication" a WHERE a."rsvpId" = NEW."id";
  END IF;
  IF FOUND AND application_status NOT IN ('OFFERED', 'ACCEPTED') THEN
    RAISE EXCEPTION 'admission_review_required: this application has no offer' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_status_guard" BEFORE UPDATE OF "status" ON "RSVP" FOR EACH ROW EXECUTE FUNCTION "admission_status_guard"();
CREATE TRIGGER "team_admission_status_guard" BEFORE UPDATE OF "status" ON "Team" FOR EACH ROW EXECUTE FUNCTION "admission_status_guard"();

-- A confirmed place accepts its offer (a settled payment, or a confirmed team).
CREATE OR REPLACE FUNCTION "admission_accept_on_confirm"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'CONFIRMED' AND OLD."status" IS DISTINCT FROM 'CONFIRMED' THEN
    UPDATE "AdmissionApplication"
      SET "status" = 'ACCEPTED', "version" = "version" + 1, "updatedAt" = (now() AT TIME ZONE 'UTC')::timestamp(3)
      WHERE "status" = 'OFFERED' AND (CASE WHEN TG_TABLE_NAME = 'Team' THEN "teamId" = NEW."id" ELSE "rsvpId" = NEW."id" END);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "rsvp_admission_accept" AFTER UPDATE OF "status" ON "RSVP" FOR EACH ROW EXECUTE FUNCTION "admission_accept_on_confirm"();
CREATE TRIGGER "team_admission_accept" AFTER UPDATE OF "status" ON "Team" FOR EACH ROW EXECUTE FUNCTION "admission_accept_on_confirm"();
