import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

// Kept apart from migration-safety.test.ts (the 300-line limit); the same kind of contract.
describe("judging rounds migration safety contract", () => {
  it("adds judging rounds by expand and backfill: rounds first, then rows, then the new uniques and NOT NULL checks", () => {
    const sql = readFileSync(resolve(root, "prisma/migrations/20261112000000_judging_rounds/migration.sql"), "utf8");
    // Columns are added nullable, never dropped; event-level judging fields stay.
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|DELETE FROM/i);
    const addColumns = sql.indexOf('ALTER TABLE "JudgeReview" ADD COLUMN "roundId" TEXT;');
    const backfillRounds = sql.indexOf('INSERT INTO "JudgingRound"');
    const pointEvents = sql.indexOf('UPDATE "Event" e SET "currentJudgingRoundId"');
    const backfillReviews = sql.indexOf('UPDATE "JudgeReview" v SET "roundId"');
    const dropOldUnique = sql.indexOf('DROP INDEX "JudgeReview_submissionId_judgeUserId_key"');
    const newUnique = sql.indexOf('CREATE UNIQUE INDEX "JudgeReview_roundId_submissionId_judgeUserId_key"');
    const required = sql.indexOf('ADD CONSTRAINT "JudgeReview_round_required" CHECK ("roundId" IS NOT NULL)');
    const fillTrigger = sql.indexOf('CREATE TRIGGER "judge_review_round"');
    expect(addColumns).toBeGreaterThanOrEqual(0);
    expect(backfillRounds).toBeGreaterThan(addColumns);
    expect(pointEvents).toBeGreaterThan(backfillRounds);
    expect(backfillReviews).toBeGreaterThan(pointEvents);
    expect(dropOldUnique).toBeGreaterThan(backfillReviews);
    expect(newUnique).toBeGreaterThan(dropOldUnique);
    expect(required).toBeGreaterThan(newUnique);
    expect(fillTrigger).toBeGreaterThan(required);
    expect(sql).toContain('CREATE UNIQUE INDEX "JudgingRound_one_open_per_event" ON "JudgingRound"("eventId") WHERE "status" = \'OPEN\'');
    expect(sql).toContain('CREATE TRIGGER "event_judging_round_mirror"');
    expect(sql).toContain('FOREIGN KEY ("roundId") REFERENCES "JudgingRound"("id") ON DELETE CASCADE');
  });
});
