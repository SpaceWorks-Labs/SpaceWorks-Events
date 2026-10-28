-- Mentor Desk follow-ups (docs/MENTOR_DESK.md): only activated assignments
-- count as "mentored", who recorded a conflict, and the optional crew ticket
-- for mentors.
-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "mentorsGetCrewTicket" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MentorConflict" ADD COLUMN     "createdByUserId" TEXT;

-- AlterTable
ALTER TABLE "MentorProfile" ADD COLUMN     "crewMemberId" TEXT;

-- AlterTable
ALTER TABLE "MentorTeamAssignment" ADD COLUMN     "activatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "MentorProfile_crewMemberId_key" ON "MentorProfile"("crewMemberId");

-- AddForeignKey
ALTER TABLE "MentorProfile" ADD CONSTRAINT "MentorProfile_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "EventCrewMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorConflict" ADD CONSTRAINT "MentorConflict_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Mappings that are or were ACTIVE count as mentored. Existing ACTIVE and
-- ENDED rows are treated as activated at their activeFrom (conservative: an
-- ended row cannot tell a rejected proposal from a finished mapping).
UPDATE "MentorTeamAssignment" SET "activatedAt" = "activeFrom" WHERE "status" IN ('ACTIVE', 'ENDED');
ALTER TABLE "MentorTeamAssignment" ADD CONSTRAINT "MentorTeamAssignment_activation_shape" CHECK ("status" <> 'ACTIVE' OR "activatedAt" IS NOT NULL);
