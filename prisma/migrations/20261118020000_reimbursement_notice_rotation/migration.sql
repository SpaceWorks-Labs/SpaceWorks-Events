-- The "reimbursement available" beat rotates through policies by when it last
-- checked each one, so policies past the first page are never starved.
ALTER TABLE "ReimbursementPolicy" ADD COLUMN "noticesCheckedAt" TIMESTAMP(3);
