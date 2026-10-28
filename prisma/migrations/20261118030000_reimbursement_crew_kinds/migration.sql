-- A CREW reimbursement policy may be limited to some crew kinds (for example
-- volunteers only); empty means every crew member, as before.
ALTER TABLE "ReimbursementPolicy" ADD COLUMN "crewKinds" "CrewKind"[] DEFAULT ARRAY[]::"CrewKind"[];

-- Only a CREW policy names crew kinds.
ALTER TABLE "ReimbursementPolicy" ADD CONSTRAINT "ReimbursementPolicy_crew_kinds_shape" CHECK (
  cardinality("crewKinds") = 0 OR "eligibility" = 'CREW'
);
