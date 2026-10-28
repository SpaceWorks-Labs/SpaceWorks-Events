-- Multi-round judging with finalist advancement (docs/HACKATHON.md "Rounds").
--
-- Expand phase. Rubric lines, judge assignments and reviews gain a nullable
-- "roundId"; every event with judging data gets one "Main" round (position 1)
-- holding its existing rows and copying the event-level judging fields.
-- A CHECK keeps "roundId" set from now on, and a trigger fills it with the
-- event's current round when an insert leaves it out, so writers that predate
-- rounds keep working. The event-level fields stay, mirrored onto the current
-- round by a trigger, for this release. The contract release makes "roundId"
-- NOT NULL and drops the fill triggers and the mirrored Event fields.

-- CreateEnum
CREATE TYPE "JudgingRoundStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "JudgingRoundEntrySource" AS ENUM ('ALL_SUBMITTED', 'ADVANCED');

-- CreateEnum
CREATE TYPE "JudgeAssignmentStrategy" AS ENUM ('BALANCED', 'RANDOM');

-- CreateTable
CREATE TABLE "JudgingRound" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "status" "JudgingRoundStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewsPerProject" INTEGER,
    "scoreNormalization" "ScoreNormalization" NOT NULL DEFAULT 'RAW',
    "judgesSeeAll" BOOLEAN NOT NULL DEFAULT true,
    "freshEyes" BOOLEAN NOT NULL DEFAULT false,
    "entrySource" "JudgingRoundEntrySource" NOT NULL DEFAULT 'ALL_SUBMITTED',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "finalistsPublishedAt" TIMESTAMP(3),
    "finalizedAt" TIMESTAMP(3),
    "finalizeExceptionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JudgingRound_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JudgingRound_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 80),
    CONSTRAINT "JudgingRound_position_positive" CHECK ("position" >= 1),
    CONSTRAINT "JudgingRound_reviews_per_project_range" CHECK ("reviewsPerProject" IS NULL OR "reviewsPerProject" BETWEEN 1 AND 20),
    CONSTRAINT "JudgingRound_window_order" CHECK ("opensAt" IS NULL OR "closesAt" IS NULL OR "closesAt" > "opensAt"),
    CONSTRAINT "JudgingRound_first_takes_all" CHECK ("position" <> 1 OR "entrySource" = 'ALL_SUBMITTED'),
    -- Only a CLOSED round is finalised, and an exception reason only comes with finalising.
    CONSTRAINT "JudgingRound_finalized_shape" CHECK (("finalizedAt" IS NULL OR "status" = 'CLOSED') AND ("finalizeExceptionReason" IS NULL OR ("finalizedAt" IS NOT NULL AND char_length("finalizeExceptionReason") BETWEEN 1 AND 500)))
);

-- CreateTable
CREATE TABLE "JudgingRoundEntry" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "advancedByUserId" TEXT,
    "advancedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRank" INTEGER,

    CONSTRAINT "JudgingRoundEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JudgingRoundEntry_source_rank_positive" CHECK ("sourceRank" IS NULL OR "sourceRank" >= 1)
);

-- CreateTable
CREATE TABLE "JudgingAssignmentRun" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "strategy" "JudgeAssignmentStrategy" NOT NULL,
    "mode" TEXT NOT NULL,
    "seed" TEXT,
    "perProject" INTEGER NOT NULL,
    "judges" INTEGER NOT NULL,
    "added" INTEGER NOT NULL,
    "removed" INTEGER NOT NULL,
    "adopted" INTEGER NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "planFingerprint" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgingAssignmentRun_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JudgingAssignmentRun_shape" CHECK (
      "mode" IN ('keep', 'replace')
      AND (("strategy" = 'RANDOM') = ("seed" IS NOT NULL))
      AND ("seed" IS NULL OR "seed" ~ '^[0-9a-f]{32}$')
      AND "perProject" BETWEEN 1 AND 20
      AND "judges" >= 0 AND "added" >= 0 AND "removed" >= 0 AND "adopted" >= 0
    )
);

-- CreateTable
CREATE TABLE "JudgingRoundJudge" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgingRoundJudge_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "currentJudgingRoundId" TEXT;
ALTER TABLE "JudgingCriterion" ADD COLUMN "roundId" TEXT;
ALTER TABLE "JudgeAssignment" ADD COLUMN "roundId" TEXT;
ALTER TABLE "JudgeReview" ADD COLUMN "roundId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "JudgingRound_eventId_position_key" ON "JudgingRound"("eventId", "position");
CREATE INDEX "JudgingRound_eventId_status_idx" ON "JudgingRound"("eventId", "status");
-- At most one OPEN round per event.
CREATE UNIQUE INDEX "JudgingRound_one_open_per_event" ON "JudgingRound"("eventId") WHERE "status" = 'OPEN';
CREATE UNIQUE INDEX "JudgingRoundEntry_roundId_submissionId_key" ON "JudgingRoundEntry"("roundId", "submissionId");
CREATE INDEX "JudgingRoundEntry_submissionId_idx" ON "JudgingRoundEntry"("submissionId");
CREATE UNIQUE INDEX "JudgingRoundJudge_roundId_userId_key" ON "JudgingRoundJudge"("roundId", "userId");
CREATE INDEX "JudgingRoundJudge_userId_idx" ON "JudgingRoundJudge"("userId");
CREATE INDEX "JudgingAssignmentRun_roundId_createdAt_idx" ON "JudgingAssignmentRun"("roundId", "createdAt");
CREATE UNIQUE INDEX "Event_currentJudgingRoundId_key" ON "Event"("currentJudgingRoundId");
CREATE INDEX "JudgingCriterion_roundId_position_idx" ON "JudgingCriterion"("roundId", "position");
CREATE INDEX "JudgeReview_submissionId_idx" ON "JudgeReview"("submissionId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_currentJudgingRoundId_fkey" FOREIGN KEY ("currentJudgingRoundId") REFERENCES "JudgingRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JudgingCriterion" ADD CONSTRAINT "JudgingCriterion_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgeAssignment" ADD CONSTRAINT "JudgeAssignment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgeReview" ADD CONSTRAINT "JudgeReview_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingRound" ADD CONSTRAINT "JudgingRound_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingRoundEntry" ADD CONSTRAINT "JudgingRoundEntry_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingRoundEntry" ADD CONSTRAINT "JudgingRoundEntry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingRoundEntry" ADD CONSTRAINT "JudgingRoundEntry_advancedByUserId_fkey" FOREIGN KEY ("advancedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "JudgingRoundJudge" ADD CONSTRAINT "JudgingRoundJudge_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingRoundJudge" ADD CONSTRAINT "JudgingRoundJudge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingAssignmentRun" ADD CONSTRAINT "JudgingAssignmentRun_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JudgingAssignmentRun" ADD CONSTRAINT "JudgingAssignmentRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "JudgingFinalistNotice" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "outboxMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JudgingFinalistNotice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "JudgingFinalistNotice_email_hash_shape" CHECK ("emailHash" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "JudgingFinalistNotice_roundId_emailHash_key" ON "JudgingFinalistNotice"("roundId", "emailHash");
ALTER TABLE "JudgingFinalistNotice" ADD CONSTRAINT "JudgingFinalistNotice_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one "Main" round per event with judging data, copying the
-- event-level judging fields, then point the event and its rows at it.
INSERT INTO "JudgingRound" ("id", "eventId", "name", "position", "status", "reviewsPerProject", "scoreNormalization", "judgesSeeAll", "entrySource", "createdAt", "updatedAt")
SELECT 'jr' || md5('judging-round:' || e."id"), e."id", 'Main', 1,
       (CASE e."judgingStatus" WHEN 'OPEN' THEN 'OPEN' WHEN 'CLOSED' THEN 'CLOSED' ELSE 'DRAFT' END)::"JudgingRoundStatus",
       e."reviewsPerProject", e."scoreNormalization", e."judgesSeeAll", 'ALL_SUBMITTED',
       (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
FROM "Event" e
WHERE e."submissionsEnabled"
   OR e."judgingStatus" <> 'NOT_STARTED'
   OR e."resultsPublishedAt" IS NOT NULL
   OR EXISTS (SELECT 1 FROM "Submission" s WHERE s."eventId" = e."id")
   OR EXISTS (SELECT 1 FROM "JudgingCriterion" c WHERE c."eventId" = e."id")
   OR EXISTS (SELECT 1 FROM "JudgeAssignment" a WHERE a."eventId" = e."id")
   OR EXISTS (SELECT 1 FROM "EventAward" w WHERE w."eventId" = e."id");

UPDATE "Event" e SET "currentJudgingRoundId" = r."id"
FROM "JudgingRound" r
WHERE r."eventId" = e."id" AND r."position" = 1;

UPDATE "JudgingCriterion" c SET "roundId" = r."id"
FROM "JudgingRound" r
WHERE r."eventId" = c."eventId" AND r."position" = 1;

UPDATE "JudgeAssignment" a SET "roundId" = r."id"
FROM "JudgingRound" r
WHERE r."eventId" = a."eventId" AND r."position" = 1;

UPDATE "JudgeReview" v SET "roundId" = r."id"
FROM "Submission" s, "JudgingRound" r
WHERE s."id" = v."submissionId" AND r."eventId" = s."eventId" AND r."position" = 1;

-- Uniques now include the round (rows are all backfilled above).
DROP INDEX "JudgeAssignment_judgeUserId_submissionId_key";
DROP INDEX "JudgeReview_submissionId_judgeUserId_key";
CREATE UNIQUE INDEX "JudgeAssignment_roundId_judgeUserId_submissionId_key" ON "JudgeAssignment"("roundId", "judgeUserId", "submissionId");
CREATE UNIQUE INDEX "JudgeReview_roundId_submissionId_judgeUserId_key" ON "JudgeReview"("roundId", "submissionId", "judgeUserId");

ALTER TABLE "JudgingCriterion" ADD CONSTRAINT "JudgingCriterion_round_required" CHECK ("roundId" IS NOT NULL);
ALTER TABLE "JudgeAssignment" ADD CONSTRAINT "JudgeAssignment_round_required" CHECK ("roundId" IS NOT NULL);
ALTER TABLE "JudgeReview" ADD CONSTRAINT "JudgeReview_round_required" CHECK ("roundId" IS NOT NULL);

-- The event's current round: its pointer, else its first round, else a new
-- "Main" round copying the event-level fields (a writer that predates rounds).
CREATE OR REPLACE FUNCTION "judging_current_round"(event_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  round_id TEXT;
BEGIN
  SELECT "currentJudgingRoundId" INTO round_id FROM "Event" WHERE "id" = event_id;
  IF round_id IS NOT NULL THEN
    RETURN round_id;
  END IF;
  SELECT "id" INTO round_id FROM "JudgingRound" WHERE "eventId" = event_id ORDER BY "position" LIMIT 1;
  IF round_id IS NOT NULL THEN
    RETURN round_id;
  END IF;
  INSERT INTO "JudgingRound" ("id", "eventId", "name", "position", "status", "reviewsPerProject", "scoreNormalization", "judgesSeeAll", "entrySource", "createdAt", "updatedAt")
  SELECT 'jr' || md5('judging-round:' || e."id"), e."id", 'Main', 1,
         (CASE e."judgingStatus" WHEN 'OPEN' THEN 'OPEN' WHEN 'CLOSED' THEN 'CLOSED' ELSE 'DRAFT' END)::"JudgingRoundStatus",
         e."reviewsPerProject", e."scoreNormalization", e."judgesSeeAll", 'ALL_SUBMITTED',
         (now() AT TIME ZONE 'UTC'), (now() AT TIME ZONE 'UTC')
  FROM "Event" e WHERE e."id" = event_id
  ON CONFLICT DO NOTHING;
  SELECT "id" INTO round_id FROM "JudgingRound" WHERE "eventId" = event_id ORDER BY "position" LIMIT 1;
  RETURN round_id;
END;
$$;

-- Rubric lines and assignments: fill a missing round, and keep the round in
-- the row's own event.
CREATE OR REPLACE FUNCTION "judging_row_round"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."roundId" IS NULL THEN
    NEW."roundId" := "judging_current_round"(NEW."eventId");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "JudgingRound" WHERE "id" = NEW."roundId" AND "eventId" = NEW."eventId") THEN
    RAISE EXCEPTION 'Judging round belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "judging_criterion_round"
  BEFORE INSERT OR UPDATE OF "roundId", "eventId" ON "JudgingCriterion"
  FOR EACH ROW EXECUTE FUNCTION "judging_row_round"();

CREATE TRIGGER "judge_assignment_round"
  BEFORE INSERT OR UPDATE OF "roundId", "eventId" ON "JudgeAssignment"
  FOR EACH ROW EXECUTE FUNCTION "judging_row_round"();

-- Reviews and round entries carry no event: it comes from the submission.
CREATE OR REPLACE FUNCTION "judging_submission_round"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_id TEXT;
BEGIN
  SELECT "eventId" INTO event_id FROM "Submission" WHERE "id" = NEW."submissionId";
  IF NEW."roundId" IS NULL AND event_id IS NOT NULL THEN
    NEW."roundId" := "judging_current_round"(event_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "JudgingRound" WHERE "id" = NEW."roundId" AND "eventId" = event_id) THEN
    RAISE EXCEPTION 'Judging round belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "judge_review_round"
  BEFORE INSERT OR UPDATE OF "roundId", "submissionId" ON "JudgeReview"
  FOR EACH ROW EXECUTE FUNCTION "judging_submission_round"();

CREATE TRIGGER "judging_round_entry_event"
  BEFORE INSERT OR UPDATE OF "roundId", "submissionId" ON "JudgingRoundEntry"
  FOR EACH ROW EXECUTE FUNCTION "judging_submission_round"();

-- An event's current round must be one of its own.
CREATE OR REPLACE FUNCTION "event_current_judging_round"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."currentJudgingRoundId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "JudgingRound" WHERE "id" = NEW."currentJudgingRoundId" AND "eventId" = NEW."id") THEN
    RAISE EXCEPTION 'Judging round belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "event_current_judging_round"
  BEFORE UPDATE OF "currentJudgingRoundId" ON "Event"
  FOR EACH ROW EXECUTE FUNCTION "event_current_judging_round"();

-- For this release the event-level judging fields mirror the current round:
-- a change to them (from code or a writer that predates rounds) is copied
-- onto that round.
CREATE OR REPLACE FUNCTION "event_judging_round_mirror"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "JudgingRound" r
  SET "status" = (CASE NEW."judgingStatus" WHEN 'OPEN' THEN 'OPEN' WHEN 'CLOSED' THEN 'CLOSED' ELSE 'DRAFT' END)::"JudgingRoundStatus",
      "judgesSeeAll" = NEW."judgesSeeAll",
      "reviewsPerProject" = NEW."reviewsPerProject",
      "scoreNormalization" = NEW."scoreNormalization",
      "updatedAt" = (now() AT TIME ZONE 'UTC')
  WHERE r."id" = COALESCE(NEW."currentJudgingRoundId", (SELECT f."id" FROM "JudgingRound" f WHERE f."eventId" = NEW."id" ORDER BY f."position" LIMIT 1))
    AND (r."status"::text IS DISTINCT FROM (CASE NEW."judgingStatus" WHEN 'OPEN' THEN 'OPEN' WHEN 'CLOSED' THEN 'CLOSED' ELSE 'DRAFT' END)
         OR r."judgesSeeAll" IS DISTINCT FROM NEW."judgesSeeAll"
         OR r."reviewsPerProject" IS DISTINCT FROM NEW."reviewsPerProject"
         OR r."scoreNormalization" IS DISTINCT FROM NEW."scoreNormalization");
  RETURN NULL;
END;
$$;

CREATE TRIGGER "event_judging_round_mirror"
  AFTER UPDATE OF "judgingStatus", "judgesSeeAll", "reviewsPerProject", "scoreNormalization" ON "Event"
  FOR EACH ROW
  WHEN (OLD."judgingStatus" IS DISTINCT FROM NEW."judgingStatus"
        OR OLD."judgesSeeAll" IS DISTINCT FROM NEW."judgesSeeAll"
        OR OLD."reviewsPerProject" IS DISTINCT FROM NEW."reviewsPerProject"
        OR OLD."scoreNormalization" IS DISTINCT FROM NEW."scoreNormalization")
  EXECUTE FUNCTION "event_judging_round_mirror"();
