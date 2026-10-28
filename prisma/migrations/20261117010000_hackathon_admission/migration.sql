-- Applications and shortlisting (docs/ADMISSION.md): multi-stage review of an
-- event's registrations before places are offered. Additive only; every
-- existing event keeps admissionEnabled = false. Guards and triggers are in
-- 20261117020000_admission_guards.

-- CreateEnum
CREATE TYPE "AdmissionMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "AdmissionStageStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "AdmissionStatus" AS ENUM ('IN_REVIEW', 'OFFERED', 'WAITLISTED', 'ACCEPTED', 'REJECTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AdmissionDecisionOutcome" AS ENUM ('ADVANCE', 'ACCEPT', 'WAITLIST', 'REJECT');

-- CreateEnum
CREATE TYPE "AdmissionBatchStatus" AS ENUM ('DRAFT', 'RELEASED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdmissionAssignmentStatus" AS ENUM ('ASSIGNED', 'SUBMITTED', 'RECUSED');

-- CreateEnum
CREATE TYPE "AdmissionEntrySource" AS ENUM ('ALL', 'ADVANCED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "admissionEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "admissionMode" "AdmissionMode" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "admissionOfferCapacity" INTEGER,
ADD COLUMN     "admissionRsvpDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "emailApplicantsOnStageAdvance" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AdmissionStage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AdmissionStageStatus" NOT NULL DEFAULT 'DRAFT',
    "reviewsPerApplication" INTEGER NOT NULL DEFAULT 1,
    "blindReview" BOOLEAN NOT NULL DEFAULT false,
    "criteria" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "guidance" TEXT NOT NULL DEFAULT '',
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionApplication" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "rsvpId" TEXT,
    "teamId" TEXT,
    "status" "AdmissionStatus" NOT NULL DEFAULT 'IN_REVIEW',
    "currentStageId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "offeredAt" TIMESTAMP(3),
    "respondBy" TIMESTAMP(3),
    "offerReminderSentAt" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "skipReason" TEXT,
    "decisionRevision" INTEGER NOT NULL DEFAULT 0,
    "answersRevision" INTEGER NOT NULL DEFAULT 1,
    "answersLockedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionStageEntry" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "source" "AdmissionEntrySource" NOT NULL DEFAULT 'ALL',
    "advancedByUserId" TEXT,
    "advancedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceRank" INTEGER,

    CONSTRAINT "AdmissionStageEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionStageReviewer" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionStageReviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionReviewAssignment" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "status" "AdmissionAssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "runId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionReviewAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionReview" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "answersRevision" INTEGER NOT NULL,
    "scores" JSONB NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionReviewConflict" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reviewerUserId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'declared',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionReviewConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionAssignmentRun" (
    "id" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "strategy" "JudgeAssignmentStrategy" NOT NULL,
    "mode" TEXT NOT NULL,
    "seed" TEXT,
    "perApplication" INTEGER NOT NULL,
    "reviewers" INTEGER NOT NULL,
    "added" INTEGER NOT NULL,
    "removed" INTEGER NOT NULL,
    "inputFingerprint" TEXT NOT NULL,
    "planFingerprint" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionAssignmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDecisionBatch" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "status" "AdmissionBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "releasedByUserId" TEXT,
    "releasedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionDecisionBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionDecision" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "outcome" "AdmissionDecisionOutcome" NOT NULL,
    "expectedVersion" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "overrideReason" TEXT,
    "sourceRank" INTEGER,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdmissionAnswerRevision" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "answersRevision" INTEGER NOT NULL,
    "answers" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdmissionAnswerRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionStage_eventId_position_key" ON "AdmissionStage"("eventId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionApplication_rsvpId_key" ON "AdmissionApplication"("rsvpId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionApplication_teamId_key" ON "AdmissionApplication"("teamId");

-- CreateIndex
CREATE INDEX "AdmissionApplication_eventId_status_queuedAt_id_idx" ON "AdmissionApplication"("eventId", "status", "queuedAt", "id");

-- CreateIndex
CREATE INDEX "AdmissionApplication_eventId_status_respondBy_idx" ON "AdmissionApplication"("eventId", "status", "respondBy");

-- CreateIndex
CREATE INDEX "AdmissionApplication_currentStageId_status_idx" ON "AdmissionApplication"("currentStageId", "status");

-- CreateIndex
CREATE INDEX "AdmissionStageEntry_applicationId_idx" ON "AdmissionStageEntry"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionStageEntry_stageId_applicationId_key" ON "AdmissionStageEntry"("stageId", "applicationId");

-- CreateIndex
CREATE INDEX "AdmissionStageReviewer_userId_idx" ON "AdmissionStageReviewer"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionStageReviewer_stageId_userId_key" ON "AdmissionStageReviewer"("stageId", "userId");

-- CreateIndex
CREATE INDEX "AdmissionReviewAssignment_reviewerUserId_status_idx" ON "AdmissionReviewAssignment"("reviewerUserId", "status");

-- CreateIndex
CREATE INDEX "AdmissionReviewAssignment_applicationId_idx" ON "AdmissionReviewAssignment"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionReviewAssignment_stageId_applicationId_reviewerUse_key" ON "AdmissionReviewAssignment"("stageId", "applicationId", "reviewerUserId");

-- CreateIndex
CREATE INDEX "AdmissionReview_applicationId_stageId_idx" ON "AdmissionReview"("applicationId", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionReview_assignmentId_answersRevision_key" ON "AdmissionReview"("assignmentId", "answersRevision");

-- CreateIndex
CREATE INDEX "AdmissionReviewConflict_eventId_idx" ON "AdmissionReviewConflict"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionReviewConflict_reviewerUserId_applicationId_key" ON "AdmissionReviewConflict"("reviewerUserId", "applicationId");

-- CreateIndex
CREATE INDEX "AdmissionAssignmentRun_stageId_createdAt_idx" ON "AdmissionAssignmentRun"("stageId", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionDecisionBatch_eventId_createdAt_idx" ON "AdmissionDecisionBatch"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "AdmissionDecision_applicationId_idx" ON "AdmissionDecision"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionDecision_batchId_applicationId_key" ON "AdmissionDecision"("batchId", "applicationId");

-- CreateIndex
CREATE INDEX "AdmissionAnswerRevision_applicationId_createdAt_idx" ON "AdmissionAnswerRevision"("applicationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdmissionStage" ADD CONSTRAINT "AdmissionStage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionApplication" ADD CONSTRAINT "AdmissionApplication_currentStageId_fkey" FOREIGN KEY ("currentStageId") REFERENCES "AdmissionStage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageEntry" ADD CONSTRAINT "AdmissionStageEntry_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageEntry" ADD CONSTRAINT "AdmissionStageEntry_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageEntry" ADD CONSTRAINT "AdmissionStageEntry_advancedByUserId_fkey" FOREIGN KEY ("advancedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageReviewer" ADD CONSTRAINT "AdmissionStageReviewer_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionStageReviewer" ADD CONSTRAINT "AdmissionStageReviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewAssignment" ADD CONSTRAINT "AdmissionReviewAssignment_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewAssignment" ADD CONSTRAINT "AdmissionReviewAssignment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewAssignment" ADD CONSTRAINT "AdmissionReviewAssignment_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewAssignment" ADD CONSTRAINT "AdmissionReviewAssignment_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AdmissionAssignmentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "AdmissionReviewAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReview" ADD CONSTRAINT "AdmissionReview_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewConflict" ADD CONSTRAINT "AdmissionReviewConflict_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewConflict" ADD CONSTRAINT "AdmissionReviewConflict_reviewerUserId_fkey" FOREIGN KEY ("reviewerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionReviewConflict" ADD CONSTRAINT "AdmissionReviewConflict_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionAssignmentRun" ADD CONSTRAINT "AdmissionAssignmentRun_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionAssignmentRun" ADD CONSTRAINT "AdmissionAssignmentRun_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecisionBatch" ADD CONSTRAINT "AdmissionDecisionBatch_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecisionBatch" ADD CONSTRAINT "AdmissionDecisionBatch_releasedByUserId_fkey" FOREIGN KEY ("releasedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecision" ADD CONSTRAINT "AdmissionDecision_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AdmissionDecisionBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecision" ADD CONSTRAINT "AdmissionDecision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecision" ADD CONSTRAINT "AdmissionDecision_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "AdmissionStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionDecision" ADD CONSTRAINT "AdmissionDecision_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionAnswerRevision" ADD CONSTRAINT "AdmissionAnswerRevision_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "AdmissionApplication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdmissionAnswerRevision" ADD CONSTRAINT "AdmissionAnswerRevision_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

