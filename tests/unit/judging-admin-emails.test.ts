import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  rateLimit: vi.fn(),
  revalidatePath: vi.fn(),
  resolveOrganiser: vi.fn(),
  updateSettings: vi.fn(),
  announce: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.rateLimit }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/judgingAccess", () => ({ resolveJudgingOrganiser: mocks.resolveOrganiser }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/core/judgingEntrants", () => ({ listUnsubmittedEntrants: vi.fn(), countUnsubmittedEntrants: vi.fn() }));
vi.mock("@/lib/core/judging", () => ({ updateJudgingSettings: mocks.updateSettings, sendResultsAnnouncement: mocks.announce }));

import { saveJudgingSettings, sendResultsAnnouncement } from "@/app/actions/judging-admin";

/* The hackathon email switches and "Send results email now" through the organiser actions (lib/hackathonEmails.ts). */

const scope = { organisationSlug: "club", eventId: "event_1" };
const organiser = { userId: "user_1", organisationId: "org_1", orgSlug: "club", eventId: "event_1", eventSlug: "hack" };
const base = { submissionsEnabled: true, submissionsOpenAt: "2030-01-01T00:00:00.000Z", submissionsCloseAt: "2030-01-02T00:00:00.000Z", judgesSeeAll: true, projectGalleryPublic: false };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.rateLimit.mockResolvedValue(false);
  mocks.resolveOrganiser.mockResolvedValue(organiser);
  mocks.updateSettings.mockResolvedValue({ ok: true, data: { judgingStatus: "NOT_STARTED" } });
  mocks.announce.mockResolvedValue({ ok: true, data: { queued: 3, alreadyAnnounced: false, announcedAt: new Date() } });
});

describe("hackathon email actions", () => {
  it("passes the email switches through settings, and leaves them out when absent", async () => {
    await saveJudgingSettings({ ...scope, settings: { ...base, emailEntrantsOnResults: true, emailSubmissionReceipts: false, judgingStatus: "OPEN" } });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(organiser, { ...base, emailEntrantsOnResults: true, emailSubmissionReceipts: false });
    await saveJudgingSettings({ ...scope, settings: base });
    expect(mocks.updateSettings).toHaveBeenLastCalledWith(organiser, { ...base, emailEntrantsOnResults: undefined, emailSubmissionReceipts: undefined });
  });

  it("sends the results email now under the broadcast bucket, without leaking the announcement time", async () => {
    const res = await sendResultsAnnouncement(scope);
    expect(res).toEqual({ ok: true, data: { queued: 3, alreadyAnnounced: false } });
    expect(mocks.announce).toHaveBeenCalledWith(organiser);
    expect(mocks.rateLimit).toHaveBeenCalledWith("broadcast", "user_1");
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/club/event/event_1");
  });

  it("refuses sending now to anyone who isn't an owner or admin, and when signed out", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "judge_1" } });
    mocks.resolveOrganiser.mockResolvedValue(null);
    expect(await sendResultsAnnouncement(scope)).toEqual({ ok: false, error: expect.stringContaining("permission") });
    expect(await saveJudgingSettings({ ...scope, settings: { ...base, emailEntrantsOnResults: true } })).toEqual({ ok: false, error: expect.stringContaining("permission") });
    mocks.auth.mockResolvedValue(null);
    expect((await sendResultsAnnouncement(scope)).ok).toBe(false);
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("stops when rate limited", async () => {
    mocks.rateLimit.mockResolvedValue(true);
    expect((await sendResultsAnnouncement(scope)).ok).toBe(false);
    expect(mocks.announce).not.toHaveBeenCalled();
  });
});
