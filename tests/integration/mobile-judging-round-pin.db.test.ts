import { JudgingRoundStatus, JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * One judging round per scoring request (docs/MOBILE_API.md "Judging"): the
 * round pinned before the writes is compared after the Event lock, so an
 * organiser switching rounds mid-request makes the request fail rather than
 * write into the new round.
 */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.2.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { appSession, keyed, newKey, params } from "../helpers/mobileApi";
import { createJudgingCriterion, saveJudgeScores, setJudgingStatus, submitJudgeReview } from "@/lib/core/judging";
import { createJudgingRound } from "@/lib/core/judgingRounds";
import { judgingEventSelect } from "@/lib/core/judging/shared";
import { resolveJudgingRound } from "@/lib/core/judging/rounds/scope";
import { changeRoundStatus } from "@/lib/core/judging/rounds/status";
import { createEvent, grantJudges, judge, must, organiser, orgSlug, project, setUpRounds, tearDownRounds, users } from "./helpers/judgingRounds";
import { PUT as scores } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/[submissionId]/scores/route";

/** Round 1 open with its rubric, round 2 a DRAFT taking every project and seen by every judge. */
async function openRoundOneEvent() {
  const event = await createEvent();
  await grantJudges(event, users.j1);
  const ctx = await organiser(event);
  const entry = await project(event, "Pinned project");
  must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
  must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
  const roundOne = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
  const roundTwo = must(await createJudgingRound(ctx, { name: "Finals", entrySource: "ALL_SUBMITTED", judgesSeeAll: true, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" }));
  must(await createJudgingCriterion(ctx, { name: "Pitch", weight: 1, maxScore: 10 }, { roundId: roundTwo.id }));
  return { event, ctx, entry, roundOneId: roundOne.id, roundTwoId: roundTwo.id };
}

/** As the organiser in `tx` (holding the Event lock): close round 1 and open round 2. */
async function switchRounds(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], fixture: Awaited<ReturnType<typeof openRoundOneEvent>>) {
  const event = await tx.event.findUniqueOrThrow({ where: { id: fixture.event.id }, select: judgingEventSelect });
  for (const [id, next] of [[fixture.roundOneId, JudgingRoundStatus.CLOSED], [fixture.roundTwoId, JudgingRoundStatus.OPEN]] as const) {
    const round = await resolveJudgingRound(tx, event, id);
    must(await changeRoundStatus(tx, fixture.ctx, event, { ...round!, id }, next));
  }
}

const waitingOnLocks = async () => (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n;

describe.sequential("a scoring request keeps one judging round", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("refuses a core write pinned to a round that is no longer current, writing nothing", async () => {
    const fixture = await openRoundOneEvent();
    const ctx = await judge(fixture.event, users.j1);
    await prisma.$transaction((tx) => switchRounds(tx, fixture));
    expect(await submitJudgeReview(ctx, { submissionId: fixture.entry.id, comment: "Round one notes", submit: false }, fixture.roundOneId)).toMatchObject({ ok: false, code: "JUDGING_CLOSED" });
    expect(await saveJudgeScores(ctx, { submissionId: fixture.entry.id, scores: [] }, fixture.roundOneId)).toMatchObject({ ok: false, code: "JUDGING_CLOSED" });
    expect(await prisma.judgeReview.count({ where: { submissionId: fixture.entry.id } })).toBe(0);
    // Unpinned, or pinned to the current round, it goes ahead.
    expect(await submitJudgeReview(ctx, { submissionId: fixture.entry.id, comment: "Finals notes", submit: false }, fixture.roundTwoId)).toMatchObject({ ok: true });
  });

  it("refuses a mobile save whose round is switched between the precheck and the write, and writes nothing to the new round", async () => {
    const fixture = await openRoundOneEvent();
    const token = await appSession(users.j1);
    let locked!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    // The organiser holds the Event lock, then switches rounds once the judge's write is waiting on it.
    const organiserSwitch = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${fixture.event.id} FOR UPDATE`;
      locked();
      await gate;
      await switchRounds(tx, fixture);
    }, { timeout: 30_000, maxWait: 10_000 });
    await holding;
    const before = await waitingOnLocks();

    const request = scores(
      keyed(`/x?roundId=${fixture.roundOneId}`, { scores: [], comment: "Round one assessment" }, token, newKey(), "PUT"),
      params({ orgSlug, eventId: fixture.event.id, submissionId: fixture.entry.id }),
    );
    for (let tries = 0; (await waitingOnLocks()) <= before; tries += 1) {
      if (tries > 200) throw new Error("the judge's write never waited on the Event lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await organiserSwitch;

    const response = await request;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "JUDGING_CLOSED" } });
    expect(await prisma.judgeReview.count({ where: { roundId: fixture.roundTwoId } })).toBe(0);
    expect(await prisma.judgeScore.count({ where: { submissionId: fixture.entry.id } })).toBe(0);
  });
});
