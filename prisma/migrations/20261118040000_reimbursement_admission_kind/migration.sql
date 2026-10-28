-- Reimbursement policies for applicants who reached an admission stage
-- (docs/FINANCE.md, docs/ADMISSION.md). The new value is added on its own:
-- PostgreSQL can't use an enum value in the transaction that adds it.
ALTER TYPE "ReimbursementEligibility" ADD VALUE 'ADMISSION_STAGE';
