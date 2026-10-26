-- Follow-up to paid options and event finance: mark a member's order that
-- pays to join a team (so it is never placed as a solo registration if the
-- team is deleted mid-payment), and refuse deleting payout ledger rows
-- except when their organisation is deleted.
ALTER TABLE "Order" ADD COLUMN "teamJoin" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION "payout_ledger_no_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- An organisation's cascade runs after its row is gone; any other delete is refused.
  IF EXISTS (SELECT 1 FROM "Organisation" WHERE "id" = OLD."organisationId") THEN
    RAISE EXCEPTION 'Payout ledger rows are never deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "prize_payout_no_delete"
  BEFORE DELETE ON "PrizePayout"
  FOR EACH ROW EXECUTE FUNCTION "payout_ledger_no_delete"();

CREATE TRIGGER "claim_payout_no_delete"
  BEFORE DELETE ON "ClaimPayout"
  FOR EACH ROW EXECUTE FUNCTION "payout_ledger_no_delete"();
