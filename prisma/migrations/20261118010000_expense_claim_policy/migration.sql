-- Expense claims under a reimbursement policy. Existing claims keep a null
-- policy and no snapshot, and behave exactly as before.

-- AlterTable
ALTER TABLE "ExpenseClaim" ADD COLUMN "eligibilitySnapshot" JSONB,
ADD COLUMN "policyId" TEXT;

-- CreateIndex
CREATE INDEX "ExpenseClaim_policyId_status_idx" ON "ExpenseClaim"("policyId", "status");

-- CreateIndex
CREATE INDEX "ExpenseClaim_rsvpId_policyId_idx" ON "ExpenseClaim"("rsvpId", "policyId");

-- AddForeignKey: a policy with claims can't be deleted (it is closed
-- instead). NO ACTION rather than RESTRICT, so deleting a whole organisation,
-- which cascades to its claims and policies in one statement, still works.
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "ReimbursementPolicy"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- Only participant and crew claims carry a policy, always with its snapshot.
ALTER TABLE "ExpenseClaim" ADD CONSTRAINT "ExpenseClaim_policy_shape" CHECK (
  "policyId" IS NULL OR ("kind" IN ('PARTICIPANT', 'CREW') AND "eligibilitySnapshot" IS NOT NULL)
);

-- A claim's policy belongs to the claim's event.
CREATE OR REPLACE FUNCTION "expense_claim_policy_event"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."policyId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "ReimbursementPolicy" WHERE "id" = NEW."policyId" AND "eventId" = NEW."eventId"
  ) THEN
    RAISE EXCEPTION 'Reimbursement policy belongs to another event' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "expense_claim_policy_event"
  BEFORE INSERT OR UPDATE OF "policyId" ON "ExpenseClaim"
  FOR EACH ROW EXECUTE FUNCTION "expense_claim_policy_event"();
