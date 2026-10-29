import type { Prisma } from "@prisma/client";
import { vi } from "vitest";
import { prisma } from "@/lib/db";
import { backendPid } from "./lockWait";

/** Pause a real transaction after its RSVP lock, or after its body, before commit. */
export function holdNextTransaction(afterRsvpLock = false) {
  let ready!: (pid: number) => void;
  let release!: () => void;
  const entered = new Promise<number>((resolve) => { ready = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const original = prisma.$transaction.bind(prisma) as <T>(
    body: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number },
  ) => Promise<T>;
  const spy = vi.spyOn(prisma, "$transaction");
  spy.mockImplementationOnce(((body: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { timeout?: number }) => original(async (tx) => {
    const pid = await backendPid(tx);
    let paused = false;
    const pause = async () => { paused = true; ready(pid); await released; };
    const wrapped = new Proxy(tx, {
      get(target, key) {
        if (key !== "$queryRaw" || !afterRsvpLock) return Reflect.get(target, key);
        return async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await tx.$queryRaw(strings, ...values);
          const sql = strings.join("?");
          if (!paused && sql.includes('FROM "RSVP"') && sql.includes("FOR UPDATE")) await pause();
          return result;
        };
      },
    });
    const result = await body(wrapped);
    if (!afterRsvpLock) await pause();
    return result;
  }, { ...options, timeout: 15_000 })) as typeof prisma.$transaction);
  return { entered, release, restore: () => spy.mockRestore() };
}
