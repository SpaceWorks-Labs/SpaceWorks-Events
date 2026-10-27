-- Event crew (docs/CREW.md): an event's organising team, each with one free
-- crew ticket. A crew RSVP is a CONFIRMED registration on a one-off event with
-- no team, order or ticket type, and is kept out of every capacity count in
-- application code. Crew may file expense claims (ExpenseClaimKind CREW) once
-- an organiser turns Event.crewClaimsEnabled on. Additive only.

-- AlterEnum
ALTER TYPE "EventPageSectionType" ADD VALUE 'CREW';

-- AlterEnum
ALTER TYPE "ExpenseClaimKind" ADD VALUE 'CREW';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "crewClaimsEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RSVP" ADD COLUMN     "isCrew" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EventCrewMember" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "foodPreference" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "bio" TEXT NOT NULL DEFAULT '',
    "photoUrl" TEXT,
    "linkedinUrl" TEXT,
    "showOnPage" BOOLEAN NOT NULL DEFAULT true,
    "joinedViaLink" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventCrewMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventCrewJoinLink" (
    "eventId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventCrewJoinLink_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventCrewMember_rsvpId_key" ON "EventCrewMember"("rsvpId");

-- CreateIndex
CREATE INDEX "EventCrewMember_eventId_sortOrder_idx" ON "EventCrewMember"("eventId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EventCrewMember_eventId_email_key" ON "EventCrewMember"("eventId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "EventCrewJoinLink_token_key" ON "EventCrewJoinLink"("token");

-- AddForeignKey
ALTER TABLE "EventCrewMember" ADD CONSTRAINT "EventCrewMember_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCrewMember" ADD CONSTRAINT "EventCrewMember_rsvpId_fkey" FOREIGN KEY ("rsvpId") REFERENCES "RSVP"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventCrewJoinLink" ADD CONSTRAINT "EventCrewJoinLink_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Every RSVP row so far has isCrew = false. The check is added NOT VALID and
-- then validated, the pattern used for checks on large tables.
ALTER TABLE "RSVP" ADD CONSTRAINT "RSVP_crew_shape"
  CHECK (NOT "isCrew" OR ("eventId" IS NOT NULL AND "teamId" IS NULL AND "status" = 'CONFIRMED' AND "orderId" IS NULL AND "ticketTypeId" IS NULL)) NOT VALID;
ALTER TABLE "RSVP" VALIDATE CONSTRAINT "RSVP_crew_shape";
