-- Offline check-in replay protection (docs/SECURITY.md, help: check-in/offline).
-- A desk's queued check-in carries a clientMutationId; the first sync claims it
-- inside the check-in transaction and stores the outcome, so a retry returns
-- that outcome and never checks a guest in again after an organiser's undo.
-- New table only: no lock on existing tables beyond the foreign key's brief
-- SHARE ROW EXCLUSIVE on "Event", no scan, no backfill.
CREATE TABLE "OfflineCheckInMutation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "clientMutationId" TEXT NOT NULL,
    "rsvpId" TEXT NOT NULL,
    "checkedInAt" TIMESTAMP(3) NOT NULL,
    "force" BOOLEAN NOT NULL,
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineCheckInMutation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OfflineCheckInMutation_eventId_clientMutationId_key" ON "OfflineCheckInMutation"("eventId", "clientMutationId");
CREATE INDEX "OfflineCheckInMutation_checkedInAt_idx" ON "OfflineCheckInMutation"("checkedInAt");

ALTER TABLE "OfflineCheckInMutation" ADD CONSTRAINT "OfflineCheckInMutation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
