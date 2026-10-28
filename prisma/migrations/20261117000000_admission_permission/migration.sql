-- Application review workspace grant (docs/ADMISSION.md). Kept alone in its
-- migration: a new enum value can't be used in the transaction that adds it.

-- AlterEnum
ALTER TYPE "EventPermission" ADD VALUE 'REVIEW_APPLICATIONS';
