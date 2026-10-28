-- Idempotency keys for mobile writes (Mentor Desk). Only key and body digests
-- and small response DTOs are stored; rows expire after a day.

-- CreateTable
CREATE TABLE "MobileIdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" INTEGER NOT NULL DEFAULT 0,
    "body" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileIdempotencyKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MobileIdempotencyKey_expiresAt_idx" ON "MobileIdempotencyKey"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MobileIdempotencyKey_userId_route_keyHash_key" ON "MobileIdempotencyKey"("userId", "route", "keyHash");

-- AddForeignKey
ALTER TABLE "MobileIdempotencyKey" ADD CONSTRAINT "MobileIdempotencyKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "MobileIdempotencyKey" ADD CONSTRAINT "MobileIdempotencyKey_shape"
  CHECK (char_length("keyHash") = 64 AND char_length("requestHash") = 64 AND "status" >= 0);
