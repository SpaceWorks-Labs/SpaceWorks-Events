import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  purge: vi.fn(),
  started: vi.fn(),
  success: vi.fn(),
  failure: vi.fn(),
  payments: vi.fn(),
  alerts: vi.fn(),
  waitlists: vi.fn(),
  reminders: vi.fn(),
  webhooks: vi.fn(),
  helpExpiry: vi.fn(),
  reimbursementNotices: vi.fn(),
}));
vi.mock("@/lib/outbox", () => ({ deliverOutboxBatchWithCount: mocks.deliver }));
vi.mock("@/lib/retention", () => ({ purgeExpiredOperationalData: mocks.purge }));
vi.mock("@/lib/payments/maintenance", () => ({ runPaymentMaintenance: mocks.payments }));
vi.mock("@/lib/backupAlerts", () => ({ alertOnBackupProblems: mocks.alerts }));
vi.mock("@/lib/payments/operations", () => ({ fillWaitlists: mocks.waitlists }));
vi.mock("@/lib/eventReminders", () => ({ sendEventReminders: mocks.reminders }));
vi.mock("@/lib/webhooks/delivery", () => ({ deliverWebhookBatch: mocks.webhooks }));
vi.mock("@/lib/admission/maintenance", () => ({ runAdmissionMaintenance: async () => ({ expired: 0, reopened: 0, reminded: 0, promoted: 0 }) }));
vi.mock("@/lib/core/mentorDesk/helpExpiry", () => ({ expireHelpRequests: mocks.helpExpiry }));
vi.mock("@/lib/claims/policies/notices", () => ({ queueReimbursementNotices: mocks.reimbursementNotices }));
vi.mock("@/lib/operationalHeartbeat", () => ({
  OUTBOX_SCHEDULER_HEARTBEAT_KEY: "outbox-scheduler",
  BEAT_HEARTBEAT_KEY: "beat",
  recordHeartbeatStarted: mocks.started,
  recordHeartbeatSuccess: mocks.success,
  recordHeartbeatFailure: mocks.failure,
}));

import { drainOutbox, processRole, runOutboxScheduler, runScheduledJobs, SCHEDULED_JOBS } from "@/lib/outboxWorker";

describe("outbox scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.waitlists.mockResolvedValue({ offered: 0 });
    mocks.reminders.mockResolvedValue({ queued: 0 });
    mocks.webhooks.mockResolvedValue({ delivered: 0, failed: 0 });
    mocks.helpExpiry.mockResolvedValue({ expired: 0, released: 0 });
    mocks.started.mockResolvedValue(undefined);
    mocks.success.mockResolvedValue(undefined);
    mocks.failure.mockResolvedValue(undefined);
    mocks.alerts.mockResolvedValue(undefined);
    mocks.deliver.mockResolvedValue({ sent: 2, failed: 0, due: 2 });
    mocks.purge.mockResolvedValue({ verificationTokens: 1 });
    mocks.payments.mockResolvedValue({ expired: 1, settled: 0, refundsSubmitted: 0 });
  });

  it("does not make heartbeat observability a delivery dependency", async () => {
    mocks.started.mockRejectedValue(new Error("heartbeat unavailable"));
    mocks.success.mockRejectedValue(new Error("heartbeat unavailable"));
    await expect(runOutboxScheduler()).resolves.toMatchObject({ sent: 2, failed: 0, purged: { verificationTokens: 1 } });
    expect(mocks.deliver).toHaveBeenCalled();
    expect(mocks.purge).toHaveBeenCalled();
  });

  it("records a metadata-only scheduler failure and rethrows for the protected route", async () => {
    const error = new Error("delivery failed");
    mocks.deliver.mockRejectedValue(error);
    await expect(runOutboxScheduler()).rejects.toBe(error);
    expect(mocks.failure).toHaveBeenCalledWith("outbox-scheduler", error);
  });

  it("runs payment housekeeping first, and never lets a job stop email delivery", async () => {
    await expect(runOutboxScheduler()).resolves.toMatchObject({ payments: { expired: 1 } });
    expect(mocks.payments.mock.invocationCallOrder[0]).toBeLessThan(mocks.deliver.mock.invocationCallOrder[0]!);
    mocks.payments.mockRejectedValue(new Error("provider down"));
    mocks.purge.mockRejectedValue(new Error("database busy"));
    await expect(runOutboxScheduler()).resolves.toMatchObject({ sent: 2, payments: null, purged: null });
    expect(mocks.success).toHaveBeenCalledWith("beat", { sent: 0, failed: 2 });
  });
});

describe("worker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps sending full batches until the queue is empty", async () => {
    mocks.deliver
      .mockResolvedValueOnce({ sent: 50, failed: 0, due: 50 })
      .mockResolvedValueOnce({ sent: 48, failed: 2, due: 50 })
      .mockResolvedValueOnce({ sent: 3, failed: 0, due: 3 });
    await expect(drainOutbox()).resolves.toEqual({ sent: 101, failed: 2 });
    expect(mocks.deliver).toHaveBeenCalledTimes(3);
    expect(mocks.deliver).toHaveBeenCalledWith(50);
  });

  it("stops when the time budget is spent, leaving the rest for the next pass", async () => {
    let clock = 0;
    mocks.deliver.mockImplementation(async () => {
      clock += 15_000;
      return { sent: 50, failed: 0, due: 50 };
    });
    await expect(drainOutbox({ batch: 50, budgetMs: 40_000, now: () => clock })).resolves.toEqual({ sent: 150, failed: 0 });
    expect(mocks.deliver).toHaveBeenCalledTimes(3);
  });

  it("keeps draining past batches that contained dropped messages", async () => {
    mocks.deliver
      .mockResolvedValueOnce({ sent: 44, failed: 0, due: 50 })
      .mockResolvedValueOnce({ sent: 0, failed: 0, due: 50 })
      .mockResolvedValueOnce({ sent: 7, failed: 0, due: 7 });
    await expect(drainOutbox({ batch: 50, budgetMs: 60_000 })).resolves.toEqual({ sent: 51, failed: 0 });
    expect(mocks.deliver).toHaveBeenCalledTimes(3);
  });

  it("backs off after a batch in which every send failed (mail server down)", async () => {
    mocks.deliver.mockResolvedValue({ sent: 0, failed: 50, due: 50 });
    await expect(drainOutbox({ batch: 50, budgetMs: 60_000 })).resolves.toEqual({ sent: 0, failed: 50 });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });
});

describe("beat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.payments.mockResolvedValue({});
    mocks.purge.mockResolvedValue({});
    mocks.alerts.mockResolvedValue(undefined);
    mocks.waitlists.mockResolvedValue({ offered: 0 });
    mocks.reminders.mockResolvedValue({ queued: 0 });
    mocks.webhooks.mockResolvedValue({ delivered: 0, failed: 0 });
    mocks.helpExpiry.mockResolvedValue({ expired: 0, released: 0 });
  });

  it("runs each job only when its interval has passed", async () => {
    const lastRun = new Map<string, number>();
    const start = new Date("2030-01-01T00:00:00Z");
    await runScheduledJobs({ now: start, lastRun });
    expect(mocks.payments).toHaveBeenCalledTimes(1);
    expect(mocks.purge).toHaveBeenCalledTimes(1);

    await runScheduledJobs({ now: new Date(start.getTime() + 61_000), lastRun });
    expect(mocks.payments).toHaveBeenCalledTimes(2);
    expect(mocks.purge).toHaveBeenCalledTimes(1);

    await runScheduledJobs({ now: new Date(start.getTime() + 61 * 60_000), lastRun });
    expect(mocks.purge).toHaveBeenCalledTimes(2);
    expect(mocks.reminders).toHaveBeenCalledTimes(2);
    expect(SCHEDULED_JOBS.map((job) => job.name)).toEqual(["payments", "waitlists", "admission", "event-reminders", "webhooks", "help-queue-expiry", "reimbursement-notices", "backup-alerts", "retention"]);
  });

  it("delivers organisation webhooks as a beat job that never stops the others", async () => {
    mocks.webhooks.mockRejectedValue(new Error("webhook table unavailable"));
    const { results, failures } = await runScheduledJobs({ force: true });
    expect(failures).toBe(1);
    expect(results.webhooks).toBeNull();
    expect(mocks.purge).toHaveBeenCalled();
    await expect(runOutboxScheduler()).resolves.toHaveProperty("sent");
  });

  it("keeps going when one job fails", async () => {
    mocks.payments.mockRejectedValue(new Error("down"));
    const { failures } = await runScheduledJobs({ force: true });
    expect(failures).toBe(1);
    expect(mocks.purge).toHaveBeenCalled();
    expect(mocks.alerts).toHaveBeenCalled();
  });
});

describe("process role", () => {
  it("defaults to doing everything, and accepts only known roles", () => {
    expect(processRole(undefined)).toBe("all");
    expect(processRole(" Worker ")).toBe("worker");
    expect(processRole("beat")).toBe("beat");
    expect(processRole("web")).toBe("web");
    expect(processRole("celery")).toBe("all");
  });
});
