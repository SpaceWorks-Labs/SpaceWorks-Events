import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));

import { prisma } from "@/lib/db";
import { createEvent, grantJudges, project, setUpRounds, tearDownRounds, users } from "./helpers/judgingRounds";

/*
 * The judging rounds migration (prisma/migrations/20261112000000_judging_rounds):
 * its backfill gives an event with judging data one "Main" round holding its
 * rows and copying the event-level fields; the expand-phase triggers fill a
 * missing round for writers that predate rounds and mirror the event-level
 * fields onto the current round; deleting an event removes its rounds.
 */

const MIGRATION = readFileSync(resolve(import.meta.dirname, "../../prisma/migrations/20261112000000_judging_rounds/migration.sql"), "utf8");

/** The backfill statements, exactly as the migration runs them. */
function backfillStatements(): string[] {
  const start = MIGRATION.indexOf("-- Backfill:");
  const end = MIGRATION.indexOf("-- Uniques now include the round");
  return MIGRATION.slice(start, end)
    .split(/;\s*\n/)
    .map((statement) => statement.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter(Boolean);
}

class Rollback extends Error {}

describe.sequential("judging rounds migration", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("backfills a Main round per event with judging data, holding its rows and copying its fields", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1);
    const entry = await project(event, "Legacy");
    // Rows written the way the app wrote them before rounds (no roundId).
    const criterion = await prisma.judgingCriterion.create({ data: { eventId: event.id, name: "Impact", weight: 1, maxScore: 10 } });
    await prisma.event.update({ where: { id: event.id }, data: { judgingStatus: JudgingStatus.OPEN, judgesSeeAll: false, reviewsPerProject: 2, scoreNormalization: "ZSCORE" } });
    await prisma.judgeAssignment.create({ data: { eventId: event.id, judgeUserId: users.j1, submissionId: entry.id } });
    await prisma.judgeScore.create({ data: { submissionId: entry.id, judgeUserId: users.j1, criterionId: criterion.id, score: 7 } });
    await prisma.judgeReview.create({ data: { submissionId: entry.id, judgeUserId: users.j1, submittedAt: new Date() } });
    const statements = backfillStatements();
    expect(statements).toHaveLength(5);

    await expect(
      prisma.$transaction(async (tx) => {
        // Rewind this database to before the migration's backfill, inside a transaction that is rolled back.
        for (const table of ["JudgingCriterion", "JudgeAssignment", "JudgeReview"]) {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT "${table}_round_required"`);
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER USER`);
          await tx.$executeRawUnsafe(`UPDATE "${table}" SET "roundId" = NULL`);
        }
        await tx.$executeRawUnsafe(`ALTER TABLE "Event" DISABLE TRIGGER USER`);
        await tx.$executeRawUnsafe(`UPDATE "Event" SET "currentJudgingRoundId" = NULL`);
        await tx.$executeRawUnsafe(`DELETE FROM "JudgingRound"`);
        for (const statement of statements) await tx.$executeRawUnsafe(statement);

        const rounds = await tx.judgingRound.findMany({ where: { eventId: event.id } });
        expect(rounds).toHaveLength(1);
        expect(rounds[0]).toMatchObject({ name: "Main", position: 1, status: "OPEN", judgesSeeAll: false, reviewsPerProject: 2, scoreNormalization: "ZSCORE", entrySource: "ALL_SUBMITTED" });
        const roundId = rounds[0]!.id;
        expect(await tx.event.findUniqueOrThrow({ where: { id: event.id }, select: { currentJudgingRoundId: true } })).toEqual({ currentJudgingRoundId: roundId });
        expect(await tx.judgingCriterion.findUniqueOrThrow({ where: { id: criterion.id } })).toMatchObject({ roundId });
        expect(await tx.judgeAssignment.count({ where: { eventId: event.id, roundId } })).toBe(1);
        expect(await tx.judgeReview.count({ where: { submissionId: entry.id, roundId } })).toBe(1);
        // Every judging row of every event now has a round.
        const [orphans] = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT (SELECT count(*) FROM "JudgingCriterion" WHERE "roundId" IS NULL) + (SELECT count(*) FROM "JudgeAssignment" WHERE "roundId" IS NULL) + (SELECT count(*) FROM "JudgeReview" WHERE "roundId" IS NULL) AS "count"`,
        );
        expect(Number(orphans!.count)).toBe(0);
        throw new Rollback();
      }, { timeout: 60_000 }),
    ).rejects.toBeInstanceOf(Rollback);
  });

  it("fills a missing round for writers that predate rounds, and mirrors the event-level fields", async () => {
    const event = await prisma.event.update({ where: { id: (await createEvent()).id }, data: { judgingStatus: JudgingStatus.OPEN, reviewsPerProject: 3 } });
    expect(await prisma.judgingRound.count({ where: { eventId: event.id } })).toBe(0);
    const criterion = await prisma.judgingCriterion.create({ data: { eventId: event.id, name: "Impact", weight: 1, maxScore: 10 } });
    const round = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id } });
    expect(criterion.roundId).toBe(round.id);
    expect(round).toMatchObject({ name: "Main", position: 1, status: "OPEN", reviewsPerProject: 3 });
    await prisma.event.update({ where: { id: event.id }, data: { judgingStatus: JudgingStatus.CLOSED, scoreNormalization: "ZSCORE" } });
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: round.id } })).toMatchObject({ status: "CLOSED", scoreNormalization: "ZSCORE" });
  });

  it("keeps roundId set, and removes rounds and their rows with the event", async () => {
    const event = await createEvent();
    await prisma.judgingCriterion.create({ data: { eventId: event.id, name: "Impact", weight: 1, maxScore: 10 } });
    // Clearing it puts the row back in the current round (trigger); with the trigger off, the CHECK refuses it.
    await prisma.$executeRawUnsafe(`UPDATE "JudgingCriterion" SET "roundId" = NULL WHERE "eventId" = $1`, event.id);
    expect(await prisma.judgingCriterion.count({ where: { eventId: event.id, roundId: null } })).toBe(0);
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`ALTER TABLE "JudgingCriterion" DISABLE TRIGGER USER`);
        await tx.$executeRawUnsafe(`UPDATE "JudgingCriterion" SET "roundId" = NULL WHERE "eventId" = $1`, event.id);
      }),
    ).rejects.toThrow();
    await prisma.event.delete({ where: { id: event.id } });
    expect(await prisma.judgingRound.count({ where: { eventId: event.id } })).toBe(0);
    expect(await prisma.judgingCriterion.count({ where: { eventId: event.id } })).toBe(0);
  });
});
