-- Volunteer shifts and contributor hours (docs/VOLUNTEERS.md), after the
-- Space Works contributions design: crew kind and account link, shifts with a
-- FIFO waitlist, shift attendance separate from event check-in, hours that
-- leave PENDING only through an append-only entry by a second person, and
-- contributor certificates that are revoked when hours change.

-- CreateEnum
CREATE TYPE "CrewKind" AS ENUM ('ORGANISER', 'VOLUNTEER', 'MENTOR', 'JUDGE');

-- CreateEnum
CREATE TYPE "VolunteerSignupStatus" AS ENUM ('APPLIED', 'WAITLISTED', 'APPROVED', 'WITHDRAWN', 'DECLINED');

-- CreateEnum
CREATE TYPE "VolunteerAttendanceState" AS ENUM ('SCHEDULED', 'CHECKED_IN', 'CHECKED_OUT', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "VolunteerHoursState" AS ENUM ('PENDING', 'VERIFIED', 'ADJUSTED');

-- CreateEnum
CREATE TYPE "VolunteerHoursEntryKind" AS ENUM ('VERIFIED', 'ADJUSTED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "contributorCertificateTemplate" JSONB,
ADD COLUMN     "volunteerShiftsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "EventCrewJoinLink" ADD COLUMN     "kind" "CrewKind" NOT NULL DEFAULT 'VOLUNTEER';

-- AlterTable
ALTER TABLE "EventCrewMember" ADD COLUMN     "kind" "CrewKind" NOT NULL DEFAULT 'VOLUNTEER',
ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "VolunteerShift" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "zone" TEXT NOT NULL DEFAULT '',
    "task" TEXT NOT NULL DEFAULT '',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "signupDeadline" TIMESTAMP(3) NOT NULL,
    "waitlistEnabled" BOOLEAN NOT NULL DEFAULT true,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT true,
    "graceMinutes" INTEGER NOT NULL DEFAULT 15,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerShift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerShiftSignup" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "status" "VolunteerSignupStatus" NOT NULL DEFAULT 'APPLIED',
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "attendance" "VolunteerAttendanceState" NOT NULL DEFAULT 'SCHEDULED',
    "checkedInAt" TIMESTAMP(3),
    "checkedOutAt" TIMESTAMP(3),
    "breakMinutes" INTEGER NOT NULL DEFAULT 0,
    "attendanceSource" TEXT,
    "attendanceActorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerShiftSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerAttendanceCorrection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolunteerAttendanceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerHours" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "signupId" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "state" "VolunteerHoursState" NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VolunteerHours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VolunteerHoursEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "hoursId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "previousVersion" INTEGER NOT NULL,
    "minutes" INTEGER NOT NULL,
    "kind" "VolunteerHoursEntryKind" NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VolunteerHoursEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContributorCertificate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "kind" "CrewKind" NOT NULL,
    "minutes" INTEGER NOT NULL,
    "template" JSONB,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "ContributorCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VolunteerShift_eventId_startsAt_idx" ON "VolunteerShift"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "VolunteerShiftSignup_eventId_crewMemberId_idx" ON "VolunteerShiftSignup"("eventId", "crewMemberId");

-- CreateIndex
CREATE INDEX "VolunteerShiftSignup_shiftId_status_queuedAt_idx" ON "VolunteerShiftSignup"("shiftId", "status", "queuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerShiftSignup_shiftId_crewMemberId_key" ON "VolunteerShiftSignup"("shiftId", "crewMemberId");

-- CreateIndex
CREATE INDEX "VolunteerAttendanceCorrection_signupId_idx" ON "VolunteerAttendanceCorrection"("signupId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerHours_signupId_key" ON "VolunteerHours"("signupId");

-- CreateIndex
CREATE INDEX "VolunteerHours_eventId_idx" ON "VolunteerHours"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "VolunteerHoursEntry_hoursId_previousVersion_key" ON "VolunteerHoursEntry"("hoursId", "previousVersion");

-- CreateIndex
CREATE UNIQUE INDEX "ContributorCertificate_token_key" ON "ContributorCertificate"("token");

-- CreateIndex
CREATE INDEX "ContributorCertificate_eventId_idx" ON "ContributorCertificate"("eventId");

-- CreateIndex
CREATE INDEX "ContributorCertificate_crewMemberId_idx" ON "ContributorCertificate"("crewMemberId");

-- CreateIndex
CREATE INDEX "EventCrewMember_userId_idx" ON "EventCrewMember"("userId");

-- AddForeignKey
ALTER TABLE "EventCrewMember" ADD CONSTRAINT "EventCrewMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerShift" ADD CONSTRAINT "VolunteerShift_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerShiftSignup" ADD CONSTRAINT "VolunteerShiftSignup_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "VolunteerShift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerShiftSignup" ADD CONSTRAINT "VolunteerShiftSignup_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "EventCrewMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerAttendanceCorrection" ADD CONSTRAINT "VolunteerAttendanceCorrection_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "VolunteerShiftSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerHours" ADD CONSTRAINT "VolunteerHours_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "VolunteerShiftSignup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VolunteerHoursEntry" ADD CONSTRAINT "VolunteerHoursEntry_hoursId_fkey" FOREIGN KEY ("hoursId") REFERENCES "VolunteerHours"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContributorCertificate" ADD CONSTRAINT "ContributorCertificate_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "EventCrewMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Shapes the application also validates; the database is the final word.
ALTER TABLE "VolunteerShift" ADD CONSTRAINT "VolunteerShift_shape" CHECK (
  "endsAt" > "startsAt"
  AND "endsAt" <= "startsAt" + INTERVAL '12 hours'
  AND "signupDeadline" <= "startsAt"
  AND "graceMinutes" BETWEEN 0 AND 60
  AND "capacity" BETWEEN 0 AND 10000
  AND char_length(btrim("title")) BETWEEN 1 AND 120
  AND char_length("zone") <= 100
  AND char_length("task") <= 200
);

ALTER TABLE "VolunteerShiftSignup" ADD CONSTRAINT "VolunteerShiftSignup_attendance_shape" CHECK (
  "breakMinutes" BETWEEN 0 AND 720
  AND ("attendanceSource" IS NULL OR "attendanceSource" IN ('self', 'desk'))
  AND ("attendance" = 'SCHEDULED' OR "status" = 'APPROVED')
  AND (
    ("attendance" IN ('SCHEDULED', 'NO_SHOW') AND "checkedInAt" IS NULL AND "checkedOutAt" IS NULL)
    OR ("attendance" = 'CHECKED_IN' AND "checkedInAt" IS NOT NULL AND "checkedOutAt" IS NULL)
    OR ("attendance" = 'CHECKED_OUT' AND "checkedInAt" IS NOT NULL AND "checkedOutAt" >= "checkedInAt")
  )
);

ALTER TABLE "VolunteerAttendanceCorrection" ADD CONSTRAINT "VolunteerAttendanceCorrection_shape" CHECK (
  "action" IN ('check-in', 'check-out') AND char_length(btrim("reason")) BETWEEN 1 AND 500
);

ALTER TABLE "VolunteerHours" ADD CONSTRAINT "VolunteerHours_shape" CHECK ("minutes" BETWEEN 0 AND 1440 AND "version" >= 0);

ALTER TABLE "VolunteerHoursEntry" ADD CONSTRAINT "VolunteerHoursEntry_shape" CHECK (
  "minutes" BETWEEN 0 AND 1440
  AND "previousVersion" >= 0
  AND char_length("reason") <= 500
  AND ("kind" = 'VERIFIED' OR char_length(btrim("reason")) >= 1)
);

ALTER TABLE "ContributorCertificate" ADD CONSTRAINT "ContributorCertificate_shape" CHECK (
  "minutes" >= 0
  AND char_length("role") <= 120
  AND char_length("token") BETWEEN 32 AND 128
  AND (("revokedAt" IS NULL) = ("revokedReason" IS NULL))
);

-- One live certificate per crew member; a revoked one stays as history.
CREATE UNIQUE INDEX "ContributorCertificate_one_live_per_member" ON "ContributorCertificate"("crewMemberId") WHERE "revokedAt" IS NULL;

-- Verification history is append-only: never updated, and deleted only with
-- its hours row. The verifier is never the volunteer (linked account or same
-- email), and the entry belongs to the hours' event.
CREATE OR REPLACE FUNCTION "volunteer_hours_entry_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Volunteer hours entries are append-only' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "VolunteerHours" WHERE "id" = OLD."hoursId") THEN
      RAISE EXCEPTION 'Volunteer hours entries are append-only' USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "VolunteerHours" h WHERE h."id" = NEW."hoursId" AND h."eventId" = NEW."eventId") THEN
    RAISE EXCEPTION 'Volunteer hours entry event mismatch' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "VolunteerHours" h
    JOIN "VolunteerShiftSignup" s ON s."id" = h."signupId"
    JOIN "EventCrewMember" m ON m."id" = s."crewMemberId"
    LEFT JOIN "User" u ON u."id" = NEW."actorUserId"
    WHERE h."id" = NEW."hoursId"
      AND (m."userId" = NEW."actorUserId" OR lower(btrim(u."email")) = m."email")
  ) THEN
    RAISE EXCEPTION 'Another person must verify volunteer hours' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "volunteer_hours_entry_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "VolunteerHoursEntry"
  FOR EACH ROW EXECUTE FUNCTION "volunteer_hours_entry_guard"();

-- Hours change only with the entry that records the change: the version moves
-- by one and an entry for the previous version carries the new minutes and
-- state. Hours are deleted only with their sign-up.
CREATE OR REPLACE FUNCTION "volunteer_hours_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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

CREATE TRIGGER "volunteer_hours_guard"
  BEFORE UPDATE OR DELETE ON "VolunteerHours"
  FOR EACH ROW EXECUTE FUNCTION "volunteer_hours_guard"();

-- Desk corrections are append-only too, removed only with their sign-up.
CREATE OR REPLACE FUNCTION "volunteer_correction_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM "VolunteerShiftSignup" WHERE "id" = OLD."signupId") THEN
    RAISE EXCEPTION 'Attendance corrections are append-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "volunteer_correction_append_only"
  BEFORE UPDATE OR DELETE ON "VolunteerAttendanceCorrection"
  FOR EACH ROW EXECUTE FUNCTION "volunteer_correction_append_only"();
