-- CreateEnum
CREATE TYPE "HelpRequestStatus" AS ENUM ('OPEN', 'CLAIMED', 'RESOLVED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "HelpRequestOrigin" AS ENUM ('TEAM', 'MENTOR', 'ROUND');

-- CreateEnum
CREATE TYPE "MentorAssignmentMode" AS ENUM ('MANUAL', 'ROUND_ROBIN', 'SKILL_MATCH', 'RANDOM');

-- CreateEnum
CREATE TYPE "MentorAssignmentStatus" AS ENUM ('PROPOSED', 'ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "MentorConflictKind" AS ENUM ('DECLARED', 'AFFILIATION');

-- CreateEnum
CREATE TYPE "MentoringRoundStatus" AS ENUM ('DRAFT', 'LIVE', 'CLOSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OfficeHourBookingStatus" AS ENUM ('BOOKED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "EventPermission" ADD VALUE 'MENTOR';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "mentorDeskEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mentorHelpClaimedEmail" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MentorProfile" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" TEXT NOT NULL DEFAULT '',
    "affiliation" TEXT NOT NULL DEFAULT '',
    "availability" JSONB NOT NULL DEFAULT '[]',
    "maxActiveTeams" INTEGER NOT NULL DEFAULT 4,
    "showOnPage" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpCategory" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "skillTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "openLimit" INTEGER NOT NULL DEFAULT 1,
    "claimMinutes" INTEGER NOT NULL DEFAULT 10,
    "expiryMinutes" INTEGER NOT NULL DEFAULT 240,
    "contactNote" TEXT NOT NULL DEFAULT '',
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpRequest" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "teamId" TEXT,
    "rsvpId" TEXT,
    "raisedByUserId" TEXT,
    "origin" "HelpRequestOrigin" NOT NULL,
    "roundId" TEXT,
    "summary" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "status" "HelpRequestStatus" NOT NULL DEFAULT 'OPEN',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "claimedByUserId" TEXT,
    "claimId" TEXT,
    "claimGeneration" INTEGER NOT NULL DEFAULT 0,
    "claimExpiresAt" TIMESTAMP(3),
    "openGeneration" INTEGER NOT NULL DEFAULT 1,
    "exclusiveUntil" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastOpenedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstClaimedAt" TIMESTAMP(3),
    "lastClaimedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "rating" INTEGER,
    "dedupKey" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HelpRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpRequestActivity" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "kind" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpRequestActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HelpRequestComment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "origin" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpRequestComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorAssignmentRun" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roundId" TEXT,
    "mode" "MentorAssignmentMode" NOT NULL,
    "seed" TEXT,
    "inputFingerprint" TEXT NOT NULL,
    "decisions" JSONB NOT NULL,
    "uncoveredTeamIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorAssignmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorTeamAssignment" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roundId" TEXT,
    "mentorUserId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "mode" "MentorAssignmentMode" NOT NULL,
    "status" "MentorAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "runId" TEXT,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorTeamAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorConflict" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "kind" "MentorConflictKind" NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentorConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeHourSlot" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "capacity" INTEGER NOT NULL DEFAULT 1,
    "bookingDeadline" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficeHourSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeHourBooking" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "bookedByUserId" TEXT,
    "status" "OfficeHourBookingStatus" NOT NULL DEFAULT 'BOOKED',
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "OfficeHourBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfficeHourChange" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "reason" TEXT NOT NULL,
    "oldSchedule" JSONB NOT NULL,
    "newSchedule" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfficeHourChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentoringRound" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3) NOT NULL,
    "closesAt" TIMESTAMP(3) NOT NULL,
    "status" "MentoringRoundStatus" NOT NULL DEFAULT 'DRAFT',
    "formSchema" JSONB NOT NULL DEFAULT '[]',
    "formVersion" INTEGER NOT NULL DEFAULT 1,
    "helpTriggerRules" JSONB NOT NULL DEFAULT '[]',
    "allowFreshEyesOverride" BOOLEAN NOT NULL DEFAULT false,
    "allowConflictOverride" BOOLEAN NOT NULL DEFAULT false,
    "freshEyesAcrossStages" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentoringRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentoringRoundMentor" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentoringRoundMentor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentoringVisit" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "leaseId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "overrideReason" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentoringVisit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentoringCheckIn" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "formSnapshot" JSONB NOT NULL,
    "answers" JSONB NOT NULL,
    "overrideReason" TEXT NOT NULL DEFAULT '',
    "away" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MentoringCheckIn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorNomination" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "mentorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorNomination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_eventId_userId_key" ON "MentorProfile"("eventId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpCategory_eventId_key_key" ON "HelpCategory"("eventId", "key");

-- CreateIndex
CREATE INDEX "HelpRequest_eventId_status_priority_createdAt_idx" ON "HelpRequest"("eventId", "status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "HelpRequest_teamId_status_idx" ON "HelpRequest"("teamId", "status");

-- CreateIndex
CREATE INDEX "HelpRequest_rsvpId_status_idx" ON "HelpRequest"("rsvpId", "status");

-- CreateIndex
CREATE INDEX "HelpRequest_status_expiresAt_idx" ON "HelpRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "HelpRequestActivity_requestId_createdAt_idx" ON "HelpRequestActivity"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "HelpRequestComment_requestId_createdAt_idx" ON "HelpRequestComment"("requestId", "createdAt");

-- CreateIndex
CREATE INDEX "MentorAssignmentRun_eventId_createdAt_idx" ON "MentorAssignmentRun"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "MentorTeamAssignment_eventId_status_idx" ON "MentorTeamAssignment"("eventId", "status");

-- CreateIndex
CREATE INDEX "MentorTeamAssignment_mentorUserId_status_idx" ON "MentorTeamAssignment"("mentorUserId", "status");

-- CreateIndex
CREATE INDEX "MentorTeamAssignment_teamId_idx" ON "MentorTeamAssignment"("teamId");

-- CreateIndex
CREATE INDEX "MentorConflict_eventId_mentorUserId_idx" ON "MentorConflict"("eventId", "mentorUserId");

-- CreateIndex
CREATE INDEX "MentorConflict_teamId_idx" ON "MentorConflict"("teamId");

-- CreateIndex
CREATE INDEX "OfficeHourSlot_eventId_startsAt_idx" ON "OfficeHourSlot"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "OfficeHourSlot_mentorUserId_startsAt_idx" ON "OfficeHourSlot"("mentorUserId", "startsAt");

-- CreateIndex
CREATE INDEX "OfficeHourBooking_eventId_status_idx" ON "OfficeHourBooking"("eventId", "status");

-- CreateIndex
CREATE INDEX "OfficeHourBooking_teamId_status_idx" ON "OfficeHourBooking"("teamId", "status");

-- CreateIndex
CREATE INDEX "OfficeHourChange_slotId_createdAt_idx" ON "OfficeHourChange"("slotId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MentoringRound_eventId_position_key" ON "MentoringRound"("eventId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MentoringRoundMentor_roundId_mentorUserId_key" ON "MentoringRoundMentor"("roundId", "mentorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MentoringVisit_roundId_teamId_key" ON "MentoringVisit"("roundId", "teamId");

-- CreateIndex
CREATE INDEX "MentoringCheckIn_eventId_mentorUserId_idx" ON "MentoringCheckIn"("eventId", "mentorUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MentoringCheckIn_roundId_teamId_key" ON "MentoringCheckIn"("roundId", "teamId");

-- CreateIndex
CREATE INDEX "MentorNomination_eventId_idx" ON "MentorNomination"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "MentorNomination_roundId_mentorUserId_teamId_key" ON "MentorNomination"("roundId", "mentorUserId", "teamId");

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpCategory" ADD CONSTRAINT "HelpCategory_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HelpCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_raisedByUserId_fkey" FOREIGN KEY ("raisedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_claimedByUserId_fkey" FOREIGN KEY ("claimedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequestActivity" ADD CONSTRAINT "HelpRequestActivity_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HelpRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequestActivity" ADD CONSTRAINT "HelpRequestActivity_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequestComment" ADD CONSTRAINT "HelpRequestComment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "HelpRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HelpRequestComment" ADD CONSTRAINT "HelpRequestComment_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorAssignmentRun" ADD CONSTRAINT "MentorAssignmentRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorAssignmentRun" ADD CONSTRAINT "MentorAssignmentRun_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorAssignmentRun" ADD CONSTRAINT "MentorAssignmentRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "MentorAssignmentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorConflict" ADD CONSTRAINT "MentorConflict_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorConflict" ADD CONSTRAINT "MentorConflict_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorConflict" ADD CONSTRAINT "MentorConflict_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourSlot" ADD CONSTRAINT "OfficeHourSlot_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourSlot" ADD CONSTRAINT "OfficeHourSlot_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourBooking" ADD CONSTRAINT "OfficeHourBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "OfficeHourSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourBooking" ADD CONSTRAINT "OfficeHourBooking_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourBooking" ADD CONSTRAINT "OfficeHourBooking_bookedByUserId_fkey" FOREIGN KEY ("bookedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourChange" ADD CONSTRAINT "OfficeHourChange_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "OfficeHourSlot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficeHourChange" ADD CONSTRAINT "OfficeHourChange_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringRound" ADD CONSTRAINT "MentoringRound_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringRoundMentor" ADD CONSTRAINT "MentoringRoundMentor_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringRoundMentor" ADD CONSTRAINT "MentoringRoundMentor_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringVisit" ADD CONSTRAINT "MentoringVisit_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringVisit" ADD CONSTRAINT "MentoringVisit_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringVisit" ADD CONSTRAINT "MentoringVisit_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringCheckIn" ADD CONSTRAINT "MentoringCheckIn_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringCheckIn" ADD CONSTRAINT "MentoringCheckIn_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentoringCheckIn" ADD CONSTRAINT "MentoringCheckIn_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorNomination" ADD CONSTRAINT "MentorNomination_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "MentoringRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorNomination" ADD CONSTRAINT "MentorNomination_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorNomination" ADD CONSTRAINT "MentorNomination_mentorUserId_fkey" FOREIGN KEY ("mentorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Mentor Desk invariants (docs/MENTOR_DESK.md), by hand.
-- ---------------------------------------------------------------------------

ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_shape" CHECK (
  "maxActiveTeams" BETWEEN 1 AND 100
  AND cardinality("skills") <= 8
  AND char_length("bio") <= 600
  AND char_length("affiliation") <= 200
  AND jsonb_typeof("availability") = 'array'
);

ALTER TABLE "HelpCategory" ADD CONSTRAINT "HelpCategory_policy_bounds" CHECK (
  "openLimit" BETWEEN 1 AND 10
  AND "claimMinutes" BETWEEN 1 AND 60
  AND "expiryMinutes" BETWEEN 15 AND 10080
  AND "priority" BETWEEN 0 AND 100
  AND cardinality("skillTags") <= 8
);

-- Exactly one origin (a team or a solo registration), the claim and lease
-- shapes, and a 1..5 rating.
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_one_origin" CHECK (("teamId" IS NULL) <> ("rsvpId" IS NULL));
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_claim_shape" CHECK (
  ("status" = 'CLAIMED' AND "claimedByUserId" IS NOT NULL AND "claimId" IS NOT NULL AND "claimExpiresAt" IS NOT NULL AND "claimGeneration" >= 1)
  OR ("status" <> 'CLAIMED' AND "claimedByUserId" IS NULL AND "claimId" IS NULL AND "claimExpiresAt" IS NULL)
);
ALTER TABLE "HelpRequest" ADD CONSTRAINT "HelpRequest_text_bounds" CHECK (
  char_length("summary") BETWEEN 1 AND 1000 AND char_length("location") <= 120
  AND ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);

-- A mentor holds at most one live claim per event.
CREATE UNIQUE INDEX "HelpRequest_one_claim_per_mentor" ON "HelpRequest" ("eventId", "claimedByUserId") WHERE "status" = 'CLAIMED';

ALTER TABLE "HelpRequestComment" ADD CONSTRAINT "HelpRequestComment_shape" CHECK (
  char_length("body") BETWEEN 1 AND 2000 AND "origin" IN ('TEAM', 'MENTOR')
);

ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_end_shape" CHECK (
  ("status" IN ('PROPOSED', 'ACTIVE') AND "endedAt" IS NULL) OR ("status" = 'ENDED' AND "endedAt" IS NOT NULL)
);
-- One live mapping per mentor and team in each scope (event-wide or one round).
CREATE UNIQUE INDEX "MentorTeamAssignment_live_unique" ON "MentorTeamAssignment" ("eventId", "mentorUserId", "teamId", COALESCE("roundId", '')) WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "MentorConflict_live_kind" ON "MentorConflict" ("eventId", "mentorUserId", "teamId", "kind") WHERE "active";
ALTER TABLE "MentorConflict" ADD CONSTRAINT "MentorConflict_reason_length" CHECK (char_length("reason") <= 300);

ALTER TABLE "OfficeHourSlot" ADD CONSTRAINT "OfficeHourSlot_shape" CHECK (
  "endsAt" > "startsAt" AND "bookingDeadline" <= "startsAt" AND "capacity" BETWEEN 1 AND 50 AND char_length("location") <= 120
);
CREATE UNIQUE INDEX "OfficeHourBooking_live_team_slot" ON "OfficeHourBooking" ("slotId", "teamId") WHERE "status" = 'BOOKED';
ALTER TABLE "OfficeHourBooking" ADD CONSTRAINT "OfficeHourBooking_cancel_shape" CHECK (("status" = 'BOOKED') = ("cancelledAt" IS NULL));

ALTER TABLE "MentoringRound" ADD CONSTRAINT "MentoringRound_window" CHECK ("closesAt" > "opensAt" AND char_length("label") BETWEEN 1 AND 100);
CREATE UNIQUE INDEX "MentoringRound_one_live" ON "MentoringRound" ("eventId") WHERE "status" = 'LIVE';

-- Append-only ledgers. Updates may only clear a user reference (ON DELETE SET
-- NULL); deletes only happen through a cascade from a parent that is already
-- gone. Arguments: 'parent:<Table>:<column>' and 'ref:<column>'.
CREATE OR REPLACE FUNCTION "mentor_desk_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  arg text;
  parts text[];
  old_row jsonb := to_jsonb(OLD);
  new_row jsonb;
  parent_exists boolean;
  orphaned boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    FOREACH arg IN ARRAY TG_ARGV LOOP
      parts := string_to_array(arg, ':');
      IF parts[1] = 'parent' THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE "id" = $1)', parts[2]) INTO parent_exists USING old_row ->> parts[3];
        IF NOT parent_exists THEN orphaned := true; END IF;
      END IF;
    END LOOP;
    IF NOT orphaned THEN
      RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  new_row := to_jsonb(NEW);
  FOREACH arg IN ARRAY TG_ARGV LOOP
    parts := string_to_array(arg, ':');
    IF parts[1] = 'ref' THEN
      IF new_row -> parts[2] <> 'null'::jsonb AND new_row -> parts[2] IS DISTINCT FROM old_row -> parts[2] THEN
        RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
      END IF;
      old_row := old_row - parts[2];
      new_row := new_row - parts[2];
    END IF;
  END LOOP;
  IF old_row IS DISTINCT FROM new_row THEN
    RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "help_request_activity_append_only" BEFORE UPDATE OR DELETE ON "HelpRequestActivity"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:HelpRequest:requestId', 'ref:actorUserId');
CREATE TRIGGER "help_request_comment_append_only" BEFORE UPDATE OR DELETE ON "HelpRequestComment"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:HelpRequest:requestId', 'ref:authorUserId');
CREATE TRIGGER "mentor_assignment_run_append_only" BEFORE UPDATE OR DELETE ON "MentorAssignmentRun"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:Event:eventId', 'ref:createdByUserId', 'ref:roundId');
CREATE TRIGGER "office_hour_change_append_only" BEFORE UPDATE OR DELETE ON "OfficeHourChange"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:OfficeHourSlot:slotId', 'ref:actorUserId');
CREATE TRIGGER "mentoring_check_in_append_only" BEFORE UPDATE OR DELETE ON "MentoringCheckIn"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:MentoringRound:roundId', 'parent:Team:teamId', 'parent:User:mentorUserId');
CREATE TRIGGER "mentor_nomination_append_only" BEFORE UPDATE OR DELETE ON "MentorNomination"
  FOR EACH ROW EXECUTE FUNCTION "mentor_desk_append_only"('parent:MentoringRound:roundId', 'parent:Team:teamId', 'parent:User:mentorUserId');
