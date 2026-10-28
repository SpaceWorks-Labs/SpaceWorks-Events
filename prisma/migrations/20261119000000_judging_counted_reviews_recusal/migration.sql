-- Judging audit fixes (docs/HACKATHON.md "Finalising" and "Recusal").

-- A judge's self-recusal from an assigned project in the open round.
ALTER TABLE "JudgeAssignment" ADD COLUMN "recusedAt" TIMESTAMP(3);

-- A finalised round's counted reviews are frozen; the marker exists only on a finalised round.
-- Rounds finalised before this migration keep a null marker and are counted live, as before.
ALTER TABLE "JudgingRound" ADD COLUMN "countedFrozenAt" TIMESTAMP(3);
ALTER TABLE "JudgingRound" ADD CONSTRAINT "JudgingRound_counted_frozen_shape" CHECK ("countedFrozenAt" IS NULL OR "finalizedAt" IS NOT NULL);

-- The reviews a finalised round counted. No foreign keys to the submission or
-- judge: a deletion undo restores the submission under the same id and finds
-- its rows again; rows go with their round.
CREATE TABLE "JudgingRoundCountedReview" (
    "roundId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "judgeUserId" TEXT NOT NULL,

    CONSTRAINT "JudgingRoundCountedReview_pkey" PRIMARY KEY ("roundId","submissionId","judgeUserId")
);

ALTER TABLE "JudgingRoundCountedReview" ADD CONSTRAINT "JudgingRoundCountedReview_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
