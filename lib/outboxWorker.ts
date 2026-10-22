import "server-only";

import { alertOnBackupProblems } from "@/lib/backupAlerts";
import { deliverOutboxBatch } from "@/lib/outbox";
import {
  BEAT_HEARTBEAT_KEY,
  OUTBOX_SCHEDULER_HEARTBEAT_KEY,
  recordHeartbeatFailure,
  recordHeartbeatStarted,
  recordHeartbeatSuccess,
} from "@/lib/operationalHeartbeat";
import { purgeExpiredOperationalData } from "@/lib/retention";
import { runPaymentMaintenance } from "@/lib/payments/maintenance";
import { fillWaitlists } from "@/lib/payments/operations";
import { sendEventReminders } from "@/lib/eventReminders";
import { logOpsError } from "@/lib/opsAlerts";
import { deliverWebhookBatch } from "@/lib/webhooks/delivery";

/**
 * What this Node.js process does besides serving requests, from
 * `SWE_PROCESS_ROLE`:
 * - `web`: serves requests only; mail and timed jobs run elsewhere.
 * - `worker`: sends queued email within seconds of it being queued.
 * - `beat`: runs the timed jobs (payment holds and reminders, waitlists,
 *   event reminders, organisation webhooks, retention, backup alerts). Its jobs
 *   queue email; the worker sends it. Webhook requests go out from the beat.
 * - `all` (the default): all three in one process, for one-container installs.
 */
export type ProcessRole = "all" | "web" | "worker" | "beat";

export function processRole(value = process.env.SWE_PROCESS_ROLE): ProcessRole {
  const role = value?.trim().toLowerCase();
  return role === "web" || role === "worker" || role === "beat" ? role : "all";
}

const DEFAULT_POLL_MS = 3_000;
const BEAT_TICK_MS = 15_000;
const HEARTBEAT_EVERY_MS = 60_000;
const DELIVERY_BATCH = 50;
const MAX_BATCHES_PER_TICK = 20;

type Job = { name: string; everyMs: number; run: (now: Date) => Promise<unknown>; };

/** The beat's schedule. Every job is safe to run twice or from two processes at once. */
export const SCHEDULED_JOBS: Job[] = [
  // Expired holds, refunds and payment-link reminders: seats go back on sale promptly.
  { name: "payments", everyMs: 60_000, run: (now) => runPaymentMaintenance(now) },
  // Free seats (a raised capacity, a removed guest) go to whoever is waiting.
  { name: "waitlists", everyMs: 60_000, run: (now) => fillWaitlists(now) },
  // A reminder about a day before each event or series date.
  { name: "event-reminders", everyMs: 5 * 60_000, run: (now) => sendEventReminders(now) },
  // Organisation webhooks: due deliveries and retries (row claims make it safe on every replica).
  { name: "webhooks", everyMs: 15_000, run: () => deliverWebhookBatch() },
  { name: "backup-alerts", everyMs: 5 * 60_000, run: () => alertOnBackupProblems() },
  { name: "retention", everyMs: 60 * 60_000, run: () => purgeExpiredOperationalData() },
];

function pollMs() {
  const value = Number(process.env.OUTBOX_POLL_MS);
  return Number.isFinite(value) && value >= 500 ? Math.min(value, 60_000) : DEFAULT_POLL_MS;
}

/** Send what's queued, batch after batch, until the queue is empty or the tick's budget is used. */
export async function drainOutbox() {
  let sent = 0;
  let failed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch += 1) {
    const result = await deliverOutboxBatch(DELIVERY_BATCH);
    sent += result.sent;
    failed += result.failed;
    if (result.sent + result.failed < DELIVERY_BATCH) break;
  }
  return { sent, failed };
}

/** Runs the jobs that are due (all of them with `force`), one after another; a failing job never stops the others. */
export async function runScheduledJobs(options: { now?: Date; force?: boolean; lastRun?: Map<string, number>; } = {}) {
  const now = options.now ?? new Date();
  const results: Record<string, unknown> = {};
  let failures = 0;
  for (const job of SCHEDULED_JOBS) {
    const last = options.lastRun?.get(job.name);
    if (!options.force && last != null && now.getTime() - last < job.everyMs) continue;
    options.lastRun?.set(job.name, now.getTime());
    try {
      results[job.name] = await job.run(now);
    } catch (error) {
      failures += 1;
      results[job.name] = null;
      logOpsError(`[beat] ${job.name} failed`, { level: "error", source: "beat", title: `Scheduled job "${job.name}" failed`, error });
    }
  }
  return { results, failures };
}

/**
 * One complete pass: timed jobs, then delivery. The protected
 * `/api/internal/outbox` endpoint runs it for platforms without a worker
 * (a cron service calls it every minute) and for manual recovery.
 */
export async function runOutboxScheduler() {
  // Heartbeat persistence is observability, not part of the delivery commit.
  // A heartbeat-table issue must not stop otherwise healthy queue processing.
  await recordHeartbeatStarted(OUTBOX_SCHEDULER_HEARTBEAT_KEY).catch(() => undefined);
  try {
    // Jobs run first so expiry and refund emails go out in this pass.
    const jobs = await runScheduledJobs({ force: true });
    await recordHeartbeatSuccess(BEAT_HEARTBEAT_KEY, { sent: 0, failed: jobs.failures }).catch(() => undefined);
    const result = await drainOutbox();
    await recordHeartbeatSuccess(OUTBOX_SCHEDULER_HEARTBEAT_KEY, result).catch(() => undefined);
    const payments = (jobs.results.payments ?? null) as Awaited<ReturnType<typeof runPaymentMaintenance>> | null;
    const purged = (jobs.results.retention ?? null) as Awaited<ReturnType<typeof purgeExpiredOperationalData>> | null;
    return { ...result, purged, payments };
  } catch (error) {
    await recordHeartbeatFailure(OUTBOX_SCHEDULER_HEARTBEAT_KEY, error).catch(() => undefined);
    throw error;
  }
}

type LoopState = { running: boolean; timer?: ReturnType<typeof setInterval>; };
type BackgroundState = { started: boolean; role: ProcessRole; loops: LoopState[]; };

function backgroundState() {
  return globalThis as typeof globalThis & { __sweBackground?: BackgroundState };
}

function startLoop(everyMs: number, tick: () => Promise<void>): LoopState {
  const state: LoopState = { running: false };
  const guarded = async () => {
    if (state.running) return;
    state.running = true;
    try {
      await tick();
    } finally {
      state.running = false;
    }
  };
  void guarded();
  state.timer = setInterval(() => void guarded(), everyMs);
  state.timer.unref?.();
  return state;
}

/** The worker: polls the queue every few seconds and records a heartbeat about once a minute. */
function startWorkerLoop() {
  let lastBeat = 0;
  return startLoop(pollMs(), async () => {
    const beat = Date.now() - lastBeat >= HEARTBEAT_EVERY_MS;
    if (beat) await recordHeartbeatStarted(OUTBOX_SCHEDULER_HEARTBEAT_KEY).catch(() => undefined);
    try {
      const result = await drainOutbox();
      if (beat || result.sent + result.failed > 0) {
        lastBeat = Date.now();
        await recordHeartbeatSuccess(OUTBOX_SCHEDULER_HEARTBEAT_KEY, result).catch(() => undefined);
      }
    } catch (error) {
      // Failure metadata is persisted separately without exception text.
      logOpsError("[worker] delivery pass failed", { level: "error", source: "worker", title: "Email delivery pass failed", error });
      await recordHeartbeatFailure(OUTBOX_SCHEDULER_HEARTBEAT_KEY, error).catch(() => undefined);
    }
  });
}

/** The beat: checks every few seconds which jobs are due and runs them. */
function startBeatLoop() {
  const lastRun = new Map<string, number>();
  let lastBeat = 0;
  return startLoop(BEAT_TICK_MS, async () => {
    const due = SCHEDULED_JOBS.some((job) => Date.now() - (lastRun.get(job.name) ?? 0) >= job.everyMs);
    if (!due && Date.now() - lastBeat < HEARTBEAT_EVERY_MS) return;
    await recordHeartbeatStarted(BEAT_HEARTBEAT_KEY).catch(() => undefined);
    const { failures } = await runScheduledJobs({ lastRun });
    lastBeat = Date.now();
    await recordHeartbeatSuccess(BEAT_HEARTBEAT_KEY, { sent: 0, failed: failures }).catch(() => undefined);
  });
}

/**
 * Start this process's background work for its role, once per process. Queue
 * row claims make delivery safe across replicas; the singleton guard avoids
 * duplicate timers during dev HMR.
 */
export function startOutboxWorker(role = processRole()) {
  const runtime = backgroundState();
  if (runtime.__sweBackground?.started) return runtime.__sweBackground.role;
  const state: BackgroundState = { started: true, role, loops: [] };
  runtime.__sweBackground = state;
  if (role === "all" || role === "worker") state.loops.push(startWorkerLoop());
  if (role === "all" || role === "beat") state.loops.push(startBeatLoop());
  if (role !== "web") console.info(`[background] ${role === "all" ? "worker and beat" : role} started`);
  return role;
}
