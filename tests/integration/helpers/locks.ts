import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/*
 * Barriers for lock-order tests (docs/TESTING.md): a blocker transaction holds
 * the first lock of each competing command, the test waits until every
 * command is queued behind it, then releases them all at once. On a lock
 * order with a cycle each command takes its first lock and waits for the
 * other's, so PostgreSQL aborts one with a deadlock; on a consistent order
 * they queue on the same row and both finish.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Sessions of this database currently waiting for a lock. */
export async function lockWaiters(): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row?.n ?? 0;
}

/** Resolves once at least `count()` sessions wait for a lock; throws after `timeoutMs`. */
export async function untilLockWaiters(count: () => number, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await lockWaiters()) >= count()) return;
    await sleep(25);
  }
  throw new Error(`Expected ${count()} sessions waiting for a lock.`);
}

/** Runs `lock` in its own transaction and keeps the transaction (and its locks) open until `release`. */
export async function holdLocks(lock: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held!: () => void;
  const ready = new Promise<void>((resolve) => { held = resolve; });
  const done = prisma.$transaction(async (tx) => { await lock(tx); held(); await gate; }, { timeout: 60_000 });
  await Promise.race([ready, done]);
  return { release: async () => { release(); await done; } };
}

/**
 * Starts each command in turn, waiting until it queues behind the blocker
 * before starting the next, then releases the blocker and settles them all.
 * A deadlock surfaces as a rejected result.
 */
export async function raceBehind<T extends unknown[]>(blocker: Awaited<ReturnType<typeof holdLocks>>, ...commands: { [K in keyof T]: () => Promise<T[K]> }): Promise<{ [K in keyof T]: PromiseSettledResult<T[K]> }> {
  const started: Promise<unknown>[] = [];
  let pending = 0;
  const baseline = await lockWaiters();
  let failure: unknown = null;
  try {
    for (const command of commands) {
      // A command that settles early (it never queued) is reported, not waited for.
      pending += 1;
      started.push(command().finally(() => { pending -= 1; }));
      await untilLockWaiters(() => baseline + pending);
    }
  } catch (error) {
    failure = error;
  }
  await blocker.release();
  const settled = await Promise.allSettled(started);
  if (failure) throw failure;
  return settled as { [K in keyof T]: PromiseSettledResult<T[K]> };
}

/** The value of a fulfilled result; fails the test with the rejection otherwise. */
export function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}
