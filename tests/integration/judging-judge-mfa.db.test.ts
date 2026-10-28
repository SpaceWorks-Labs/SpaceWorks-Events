import { JudgingStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ value: null as null | { user: { id: string }; mfaVerified?: boolean } }));
vi.mock("@/lib/auth", () => ({ auth: async () => session.value }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));

import { prisma } from "@/lib/db";
import { resolveJudgeContext } from "@/lib/judgingAccess";
import { loadJudgeSubmission, loadJudgeSubmissionsPage, saveJudgeScoresAction } from "@/app/actions/judging";
import { createJudgingCriterion, listSubmissionsForJudge, saveJudgeScores, setJudgingStatus } from "@/lib/core/judging";
import { createEvent, grantJudges, judge, must, organiser, orgSlug, project, setUpRounds, tearDownRounds, users } from "./helpers/judgingRounds";

/*
 * Staff MFA for JUDGE collaborators (docs/SECURITY.md, lib/staffMfa.ts): a
 * judge whose session still owes the authenticator check gets no judging
 * access through the Server Actions, and the core re-check
 * (isEligibleJudge) refuses a context resolved before, failing closed.
 */
describe.sequential("judge staff MFA", () => {
  beforeAll(setUpRounds);
  afterAll(async () => {
    session.value = null;
    vi.unstubAllEnvs();
    await tearDownRounds();
  });

  it("refuses a JUDGE collaborator without the authenticator check, then allows them once checked", async () => {
    const event = await createEvent();
    await grantJudges(event, users.j1);
    const ctx = await organiser(event);
    const criterion = must(await createJudgingCriterion(ctx, { name: "Impact", weight: 1, maxScore: 10 }));
    must(await setJudgingStatus(ctx, JudgingStatus.OPEN));
    const entry = await project(event, "Guarded");
    // Resolved while the check is off: the core must still refuse it once the session owes the check.
    const stale = await judge(event, users.j1);
    const scope = { organisationSlug: orgSlug, eventId: event.id };

    vi.stubEnv("STAFF_MFA_REQUIRED", "true");
    try {
      await prisma.user.update({ where: { id: users.j1 }, data: { mfaEnabledAt: new Date() } });
      session.value = { user: { id: users.j1 } };
      expect(await resolveJudgeContext(users.j1, orgSlug, event.id)).toBeNull();
      expect(await loadJudgeSubmissionsPage({ ...scope, filter: "all", query: "" })).toMatchObject({ ok: false, error: expect.stringContaining("do not have access") });
      expect(await loadJudgeSubmission({ ...scope, submissionId: entry.id })).toMatchObject({ ok: false });
      expect(await saveJudgeScoresAction({ ...scope, submissionId: entry.id, scores: [{ criterionId: criterion.id, score: 5 }] })).toMatchObject({ ok: false });
      expect(await listSubmissionsForJudge(stale)).toBeNull();
      expect(await saveJudgeScores(stale, { submissionId: entry.id, scores: [{ criterionId: criterion.id, score: 5 }] })).toMatchObject({ ok: false });
      expect(await prisma.judgeScore.count({ where: { submissionId: entry.id } })).toBe(0);

      // Without an authenticator set up at all, still refused.
      await prisma.user.update({ where: { id: users.j1 }, data: { mfaEnabledAt: null } });
      expect(await resolveJudgeContext(users.j1, orgSlug, event.id)).toBeNull();

      // Checked this session: access returns.
      await prisma.user.update({ where: { id: users.j1 }, data: { mfaEnabledAt: new Date() } });
      session.value = { user: { id: users.j1 }, mfaVerified: true };
      expect(await resolveJudgeContext(users.j1, orgSlug, event.id)).not.toBeNull();
      expect(await saveJudgeScoresAction({ ...scope, submissionId: entry.id, scores: [{ criterionId: criterion.id, score: 5 }] })).toMatchObject({ ok: true });
    } finally {
      session.value = null;
      vi.stubEnv("STAFF_MFA_REQUIRED", "false");
    }
  });
});
