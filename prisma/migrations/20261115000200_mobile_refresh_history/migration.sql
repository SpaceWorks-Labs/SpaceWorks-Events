-- Remember the last few rotated-away refresh tokens of an app session (only
-- their SHA-256), so replaying any of them revokes the session, not just the
-- one rotated away last.
ALTER TABLE "MobileSession" ADD COLUMN "previousRefreshTokenHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "MobileSession" SET "previousRefreshTokenHashes" = ARRAY["previousRefreshTokenHash"] WHERE "previousRefreshTokenHash" IS NOT NULL;
DROP INDEX "MobileSession_previousRefreshTokenHash_key";
ALTER TABLE "MobileSession" DROP COLUMN "previousRefreshTokenHash";
CREATE INDEX "MobileSession_previousRefreshTokenHashes_idx" ON "MobileSession" USING GIN ("previousRefreshTokenHashes");
ALTER TABLE "MobileSession" ADD CONSTRAINT "MobileSession_refresh_history_limit"
  CHECK (cardinality("previousRefreshTokenHashes") <= 3);
