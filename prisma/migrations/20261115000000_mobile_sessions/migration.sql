-- Space Works mobile app sessions (Android and iOS). Only SHA-256 digests of
-- bearer tokens and of the app's install id are stored; rows cascade with
-- their user.

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "registrationCutoffBeforeManualClose" TIMESTAMP(3),
ADD COLUMN     "registrationLeadBeforeManualClose" INTEGER,
ADD COLUMN     "registrationManuallyClosedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MobileSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessTokenHash" TEXT NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "previousRefreshTokenHash" TEXT,
    "rotatedAt" TIMESTAMP(3),
    "sessionVersion" INTEGER NOT NULL,
    "deviceHash" TEXT NOT NULL,
    "deviceName" TEXT,
    "platform" TEXT,
    "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mfaVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "MobileSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MobileSession_accessTokenHash_key" ON "MobileSession"("accessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MobileSession_refreshTokenHash_key" ON "MobileSession"("refreshTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MobileSession_previousRefreshTokenHash_key" ON "MobileSession"("previousRefreshTokenHash");

-- CreateIndex
CREATE INDEX "MobileSession_userId_revokedAt_idx" ON "MobileSession"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "MobileSession_refreshExpiresAt_idx" ON "MobileSession"("refreshExpiresAt");

-- AddForeignKey
ALTER TABLE "MobileSession" ADD CONSTRAINT "MobileSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "MobileSession" ADD CONSTRAINT "MobileSession_shape"
  CHECK (char_length("deviceHash") = 64 AND ("platform" IS NULL OR "platform" IN ('android', 'ios')));

-- Mobile check-ins record where they came from. Existing rows already satisfy
-- the wider list.
ALTER TABLE "CheckInEvent" DROP CONSTRAINT "CheckInEvent_known_source";
ALTER TABLE "CheckInEvent" ADD CONSTRAINT "CheckInEvent_known_source"
  CHECK ("source" IN ('online', 'offline-sync', 'venue-station', 'mobile-scan', 'mobile-manual')) NOT VALID;
ALTER TABLE "CheckInEvent" VALIDATE CONSTRAINT "CheckInEvent_known_source";

-- Closing sign-ups from the app keeps exactly one of the two cutoff modes.
ALTER TABLE "Event" ADD CONSTRAINT "Event_manual_close_snapshot_mode"
  CHECK (NOT ("registrationCutoffBeforeManualClose" IS NOT NULL AND "registrationLeadBeforeManualClose" IS NOT NULL));
