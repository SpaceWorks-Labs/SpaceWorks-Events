import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/* Judging rounds through the mobile API (docs/HACKATHON.md "Rounds"): the judge's rounds, round-scoped reads, current-round writes. */

process.env.REDIS_URL = "";
process.env.TRUSTED_PROXY_IP_HEADER = "x-real-ip";

vi.mock("next-auth", () => ({ default: () => ({ auth: async () => null, handlers: {}, signIn: vi.fn(), signOut: vi.fn() }), CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: vi.fn() }));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@/lib/authAdapter", () => ({ authAdapter: {} }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": `198.18.1.${Math.floor(Math.random() * 250)}` }), cookies: async () => ({ get: () => undefined, set: vi.fn(), delete: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { appSession, get, keyed, params } from "../helpers/mobileApi";
import { applyAdvancement, previewAdvancement } from "@/lib/core/judgingRounds";
import { must, openRound, orgSlug, otherOrgSlug, setUpRounds, tearDownRounds, twoRoundEvent, users } from "./helpers/judgingRounds";
import { GET as rounds } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/rounds/route";
import { GET as summary } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/rounds/summary/route";
import { GET as criteria } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/criteria/route";
import { GET as submissions } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/route";
import { PUT as scores } from "@/app/api/mobile/v1/orgs/[orgSlug]/events/[eventId]/judging/submissions/[submissionId]/scores/route";
import { GET as finalists } from "@/app/api/mobile/v1/public/events/[orgSlug]/[eventSlug]/finalists/route";

describe.sequential("judging rounds through the mobile API", () => {
  beforeAll(setUpRounds);
  afterAll(tearDownRounds);

  it("offers a judge the opened rounds and the current one, never a later draft round, and writes only to the current round", async () => {
    const { event, ctx, projects, roundOneId, roundTwoId, firstCriterionId } = await twoRoundEvent([8, 6]);
    const judge = await appSession(users.j1);
    const at = (extra = "") => [get(`/x${extra}`, judge), params({ orgSlug, eventId: event.id })] as const;

    const before = await (await rounds(...at())).json();
    expect(before.data.rounds.map((round: { id: string; }) => round.id)).toEqual([roundOneId]);
    expect(before.data.currentRoundId).toBe(roundOneId);
    expect((await criteria(...at(`?roundId=${roundTwoId}`))).status).toBe(404);

    const preview = must(await previewAdvancement(ctx, roundTwoId, { mode: "top", count: 2 }));
    must(await applyAdvancement(ctx, roundTwoId, { mode: "top", count: 2, fingerprint: preview.fingerprint }));
    await openRound(ctx, roundTwoId);
    const after = await (await rounds(...at())).json();
    expect(after.data.rounds.map((round: { id: string; isCurrent: boolean; }) => [round.id, round.isCurrent])).toEqual([[roundOneId, false], [roundTwoId, true]]);
    const earlier = await (await submissions(...at(`?roundId=${roundOneId}`))).json();
    expect(earlier.data.round).toMatchObject({ id: roundOneId, isCurrent: false, judgingStatus: "CLOSED" });
    const current = await (await criteria(...at())).json();
    expect(current.data.round).toMatchObject({ id: roundTwoId, isCurrent: true });

    // Scores go to the current round only.
    const refused = await scores(keyed(`/x?roundId=${roundOneId}`, { scores: [{ criterionId: firstCriterionId, score: 5 }] }, judge, "unused-key-1", "PUT"), params({ orgSlug, eventId: event.id, submissionId: projects[0]!.id }));
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ error: { code: "JUDGING_CLOSED" } });
  });

  it("shows organisers a read-only round summary, and judges none", async () => {
    const { event } = await twoRoundEvent([7]);
    const owner = await appSession(users.owner);
    const judge = await appSession(users.j1);
    const view = await (await summary(get("/x", owner), params({ orgSlug, eventId: event.id }))).json();
    expect(view.data.rounds).toHaveLength(2);
    expect(view.data.rounds[0]).toMatchObject({ position: 1, status: "CLOSED", isCurrent: true });
    expect((await summary(get("/x", judge), params({ orgSlug, eventId: event.id }))).status).toBe(404);
    expect((await summary(get("/x", owner), params({ orgSlug: otherOrgSlug, eventId: event.id }))).status).toBe(404);
  });

  it("publishes no finalists before the organiser does, and hides other organisations' events", async () => {
    const { event } = await twoRoundEvent([9]);
    const page = await finalists(get("/x"), params({ orgSlug, eventSlug: event.slug }));
    expect(page.status).toBe(200);
    await expect(page.json()).resolves.toEqual({ ok: true, data: { rounds: [] } });
    expect((await finalists(get("/x"), params({ orgSlug: otherOrgSlug, eventSlug: event.slug }))).status).toBe(404);
  });
});
