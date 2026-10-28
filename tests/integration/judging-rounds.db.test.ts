import { JudgingRoundStatus, JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { createJudgingCriterion, listSubmissionsForJudge, saveJudgeScores, setJudgingStatus } from "@/lib/core/judging";
import { createJudgingRound, deleteJudgingRound, loadJudgingRounds, reorderJudgingRounds, setJudgingRoundPanel, setJudgingRoundStatus, updateJudgingRound } from "@/lib/core/judgingRounds";
import { addJudgingRound, changeJudgingRoundStatus, saveJudgingRoundPanel } from "@/app/actions/judging-rounds";
import { createEvent, grantJudges, judge, must, organiser, orgSlug, otherOrganisationId, project, setUpRounds, tearDownRounds, users } from "./helpers/judgingRounds";

/*
 * Judging rounds against PostgreSQL (docs/HACKATHON.md "Rounds"): the first
 * round and the event mirror, one OPEN round per event, round order and
 * status rules, per-round panels, tenancy, and owner/admin-only actions.
 */

const roundInput = (name: string, entrySource: "ALL_SUBMITTED" | "ADVANCED" = "ADVANCED") => ({ name, entrySource, judgesSeeAll: true, freshEyes: false, reviewsPerProject: "", scoreNormalization: "RAW", opensAt: "", closesAt: "" });

describe.sequential("judging rounds", () => {
  beforeAll(setUpRounds);
  afterAll(async () => {
    session.userId = null;
    await tearDownRounds();
  });

  it("gives an event one Main round on first use, mirrored by the event-level fields", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    expect(await prisma.judgingRound.count({ where: { eventId: event.id } })).toBe(0);
    must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const [main] = await prisma.judgingRound.findMany({ where: { eventId: event.id } });
    expect(main).toMatchObject({ name: "Main", position: 1, status: JudgingRoundStatus.DRAFT, entrySource: "ALL_SUBMITTED" });
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: main!.id } })).toMatchObject({ status: JudgingRoundStatus.OPEN });
    expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({ currentJudgingRoundId: main!.id, judgingStatus: JudgingStatus.OPEN });
    // A change to the event-level field (a writer that predates rounds) reaches the round.
    await prisma.event.update({ where: { id: event.id }, data: { judgesSeeAll: false, reviewsPerProject: 4 } });
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: main!.id } })).toMatchObject({ judgesSeeAll: false, reviewsPerProject: 4 });
    expect(await loadJudgingRounds(ctx)).toHaveLength(1);
  });

  it("keeps at most one OPEN round per event and opens rounds in order", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const second = must(await createJudgingRound(ctx, roundInput("Finals", "ALL_SUBMITTED")));
    must(await createJudgingCriterion(ctx, { name: "Pitch", weight: 1, maxScore: 10 }, { roundId: second.id }));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    // The database refuses a second OPEN round outright.
    await expect(prisma.judgingRound.update({ where: { id: second.id }, data: { status: JudgingRoundStatus.OPEN } })).rejects.toThrow();
    expect(await setJudgingRoundStatus(ctx, second.id, "OPEN")).toMatchObject({ ok: false, error: expect.stringContaining("before opening this round") });
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    must(await setJudgingRoundStatus(ctx, second.id, "OPEN"));
    const current = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    expect(current).toMatchObject({ currentJudgingRoundId: second.id, judgingStatus: JudgingStatus.OPEN });
    // The first round can't reopen or reset once a later one has opened.
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    expect(await setJudgingRoundStatus(ctx, first.id, "OPEN")).toMatchObject({ ok: false });
    expect(await setJudgingRoundStatus(ctx, first.id, "DRAFT")).toMatchObject({ ok: false });
    // Closing the last round keeps it current; the event mirrors it.
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    expect(await prisma.judgingRound.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ status: JudgingRoundStatus.CLOSED });
  });

  it("needs finalists before an ADVANCED round opens, and the first round always takes everyone", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const finals = must(await createJudgingRound(ctx, roundInput("Finals")));
    must(await createJudgingCriterion(ctx, { name: "Pitch", weight: 1, maxScore: 10 }, { roundId: finals.id }));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    must(await setJudgingStatus(ctx, JudgingStatus.CLOSED));
    expect(await setJudgingRoundStatus(ctx, finals.id, "OPEN")).toMatchObject({ ok: false, error: "Advance finalists into this round before opening it." });
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    expect(await updateJudgingRound(ctx, first.id, roundInput("Main", "ADVANCED"))).toMatchObject({ ok: false });
    await expect(prisma.judgingRound.update({ where: { id: first.id }, data: { entrySource: "ADVANCED" } })).rejects.toThrow();
    // Reordering would put an ADVANCED round first.
    expect(await reorderJudgingRounds(ctx, [finals.id, first.id])).toMatchObject({ ok: false });
  });

  it("reorders and deletes only rounds that haven't opened, keeping positions compact", async () => {
    const event = await createEvent();
    const ctx = await organiser(event);
    must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const semi = must(await createJudgingRound(ctx, roundInput("Semi-finals")));
    const finals = must(await createJudgingRound(ctx, roundInput("Finals")));
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id, position: 1 } });
    must(await reorderJudgingRounds(ctx, [first.id, finals.id, semi.id]));
    expect((await prisma.judgingRound.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" } })).map((row) => row.name)).toEqual(["Main", "Finals", "Semi-finals"]);
    expect(await deleteJudgingRound(ctx, first.id)).toMatchObject({ ok: false, error: "The first round can't be deleted." });
    must(await deleteJudgingRound(ctx, finals.id));
    expect(await prisma.judgingRound.findMany({ where: { eventId: event.id }, orderBy: { position: "asc" }, select: { name: true, position: true } })).toEqual([
      { name: "Main", position: 1 },
      { name: "Semi-finals", position: 2 },
    ]);
  });

  it("isolates rounds with their own panels; no panel means every judge", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1, users.j2);
    const ctx = await organiser(event);
    const entry = await project(event, "Panelled");
    const criterion = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id } });
    // Only people who can judge the event can sit on a panel.
    expect(await setJudgingRoundPanel(ctx, first.id, [users.outsider])).toMatchObject({ ok: false });
    must(await setJudgingRoundPanel(ctx, first.id, [users.j1]));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    const onPanel = await listSubmissionsForJudge(await judge(event, users.j1));
    const offPanel = await listSubmissionsForJudge(await judge(event, users.j2));
    expect(onPanel).toMatchObject({ onPanel: true, counts: { all: 1 } });
    expect(offPanel).toMatchObject({ onPanel: false, counts: { all: 0 } });
    expect(await saveJudgeScores(await judge(event, users.j2), { submissionId: entry.id, scores: [{ criterionId: criterion.id, score: 5 }] })).toMatchObject({ ok: false });
    must(await saveJudgeScores(await judge(event, users.j1), { submissionId: entry.id, scores: [{ criterionId: criterion.id, score: 5 }] }));
    // Clearing the panel brings everyone back.
    must(await setJudgingRoundPanel(ctx, first.id, []));
    expect(await listSubmissionsForJudge(await judge(event, users.j2))).toMatchObject({ onPanel: true, counts: { all: 1 } });
  });

  it("scopes every round to its own event and organisation", async () => {
    const event = await createEvent();
    const other = await createEvent(otherOrganisationId);
    const ctx = await organiser(event);
    const otherCtx = await organiser(other);
    must(await createJudgingCriterion(otherCtx, { name: "Impact", weight: 1, maxScore: 10 }));
    const foreign = must(await createJudgingRound(otherCtx, roundInput("Theirs")));
    expect(await updateJudgingRound(ctx, foreign.id, roundInput("Mine"))).toMatchObject({ ok: false, error: "Judging round not found." });
    expect(await setJudgingRoundStatus(ctx, foreign.id, "OPEN")).toMatchObject({ ok: false, error: "Judging round not found." });
    expect(await deleteJudgingRound(ctx, foreign.id)).toMatchObject({ ok: false, error: "Judging round not found." });
    expect(await createJudgingCriterion(ctx, { name: "X", weight: 1, maxScore: 10 }, { roundId: foreign.id })).toMatchObject({ ok: false });
    // The database keeps a round's rows in its own event.
    await expect(prisma.judgingCriterion.create({ data: { eventId: event.id, roundId: foreign.id, name: "Smuggled", weight: 1, maxScore: 10 } })).rejects.toThrow();
    await expect(prisma.event.update({ where: { id: event.id }, data: { currentJudgingRoundId: foreign.id } })).rejects.toThrow();
  });

  it("refuses every round action to judges, outsiders and signed-out visitors", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1);
    const ctx = await organiser(event);
    must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    const first = await prisma.judgingRound.findFirstOrThrow({ where: { eventId: event.id } });
    const scope = { organisationSlug: orgSlug, eventId: event.id };
    for (const userId of [users.j1, users.outsider, null]) {
      session.userId = userId;
      expect(await addJudgingRound({ ...scope, round: roundInput("Nope") })).toMatchObject({ ok: false });
      expect(await changeJudgingRoundStatus({ ...scope, roundId: first.id, status: "OPEN" })).toMatchObject({ ok: false });
      expect(await saveJudgingRoundPanel({ ...scope, roundId: first.id, userIds: [] })).toMatchObject({ ok: false });
    }
    session.userId = users.owner;
    expect(await addJudgingRound({ ...scope, round: roundInput("Finals") })).toMatchObject({ ok: true });
    session.userId = null;
    expect(await prisma.judgingRound.count({ where: { eventId: event.id } })).toBe(2);
  });
});
