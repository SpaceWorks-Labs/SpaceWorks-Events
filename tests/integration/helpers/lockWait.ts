import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export async function backendPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
  return row.pid;
}

/** Observe lock waits, never query text/arguments (which may contain bearer tokens). */
export async function waitForLockWait(blockerPid: number, count = 1) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      WITH RECURSIVE blocked(pid) AS (
        SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        UNION
        SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
        WHERE a.datname = current_database() AND a.wait_event_type = 'Lock'
      ) SELECT count(*)::int AS count FROM blocked`;
    if (row.count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Expected ${count} competing request(s) to reach a PostgreSQL lock wait.`);
}

/** Release only after verified contention, optionally making a final change under the held locks. */
export async function whileLocked<T>(
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  work: () => Promise<T>,
  options: { waiters?: number; beforeRelease?: (tx: Prisma.TransactionClient) => Promise<unknown> } = {},
): Promise<T> {
  let start!: (pid: number) => void;
  let release!: () => void;
  let rejectStart!: (error: unknown) => void;
  let observed = false;
  const ready = new Promise<number>((resolve, reject) => { start = resolve; rejectStart = reject; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await lock(tx);
    start(await backendPid(tx));
    await released;
    if (observed) await options.beforeRelease?.(tx);
  }, { timeout: 15_000 });
  void holder.catch(rejectStart);
  const pid = await ready;
  const running = Promise.resolve().then(work);
  // A rejected contender must be reported without leaving an unhandled promise.
  void running.catch(() => {});
  try {
    await waitForLockWait(pid, options.waiters);
    observed = true;
  } finally {
    release();
    await holder;
  }
  return running;
}
