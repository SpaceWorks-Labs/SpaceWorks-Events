-- Object-storage deletion queue (docs/CONFIGURATION.md "Object storage",
-- lib/storage/deletionQueue.ts). New tables only: no lock on or scan of an
-- existing table, no backfill.
--
-- Rollout requirement (docs/production-operations.md): stop every instance of
-- the previous release within an hour of this migration and never run an
-- older image against this database again. Older instances upload without
-- registering a pending deletion first.
CREATE TYPE "StorageDeletionKind" AS ENUM ('OBJECT', 'PREFIX');
CREATE TYPE "StorageDeletionState" AS ENUM ('PENDING', 'CLAIMED', 'VERIFYING');
CREATE TYPE "StorageDeletionReason" AS ENUM ('UPLOAD_PENDING', 'ORG_DELETED', 'LEGACY_PREFIX', 'UNATTACHED');

CREATE TABLE "StorageDeletion" (
    "id" TEXT NOT NULL,
    "kind" "StorageDeletionKind" NOT NULL,
    "state" "StorageDeletionState" NOT NULL DEFAULT 'PENDING',
    "location" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "organisationId" TEXT,
    "reason" "StorageDeletionReason" NOT NULL,
    "deadline" TIMESTAMP(3),
    "notBefore" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "continuationToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageDeletion_pkey" PRIMARY KEY ("id"),
    -- Only uploads carry a deadline, and only listings a continuation token.
    CONSTRAINT "StorageDeletion_deadline_shape" CHECK (("reason" = 'UPLOAD_PENDING') = ("deadline" IS NOT NULL)),
    CONSTRAINT "StorageDeletion_token_shape" CHECK ("kind" = 'PREFIX' OR "continuationToken" IS NULL),
    CONSTRAINT "StorageDeletion_error_code_length" CHECK (char_length("lastErrorCode") <= 64)
);

CREATE UNIQUE INDEX "StorageDeletion_location_key_kind_key" ON "StorageDeletion"("location", "key", "kind");
CREATE INDEX "StorageDeletion_state_notBefore_idx" ON "StorageDeletion"("state", "notBefore");
CREATE INDEX "StorageDeletion_notBefore_idx" ON "StorageDeletion"("notBefore");

-- The protocol epoch: when this database started registering uploads. The
-- value is UTC wall-clock time, like every other timestamp(3) column.
CREATE TABLE "StorageProtocol" (
    "id" INTEGER NOT NULL,
    "enabledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageProtocol_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StorageProtocol_single_row" CHECK ("id" = 1)
);
INSERT INTO "StorageProtocol" ("id", "enabledAt") VALUES (1, (now() AT TIME ZONE 'UTC')::timestamp(3));
