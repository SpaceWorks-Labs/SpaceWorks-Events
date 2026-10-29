import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { PersonsChanged, requirePersonsLocked, retryWhenPersonsChange } from "@/lib/personLock";

/* The person lock's re-check and retry (lib/personLock.ts, docs/VOLUNTEERS.md "Locks"). */

function txWith(crewUserIds: Array<string | null>, profileUserIds: string[]) {
  return {
    eventCrewMember: { findMany: vi.fn(async () => crewUserIds.filter(Boolean).map((userId) => ({ userId }))) },
    mentorProfile: { findMany: vi.fn(async () => profileUserIds.map((userId) => ({ userId }))) },
  } as unknown as Prisma.TransactionClient;
}

describe("person lock", () => {
  it("accepts crew places whose people were all locked, through either link", async () => {
    await expect(requirePersonsLocked(txWith(["u1"], ["u2"]), "e1", ["c1", "c2"], ["u1", "u2"])).resolves.toBeUndefined();
    await expect(requirePersonsLocked(txWith([null], []), "e1", ["c1"], [])).resolves.toBeUndefined();
  });

  it("refuses when a crew place gained a person who was not locked", async () => {
    await expect(requirePersonsLocked(txWith([null], ["mentor"]), "e1", ["c1"], [])).rejects.toBeInstanceOf(PersonsChanged);
  });

  it("runs again after PersonsChanged, gives up after three tries, and passes other errors on", async () => {
    let calls = 0;
    await expect(retryWhenPersonsChange(async () => { calls += 1; if (calls < 3) throw new PersonsChanged(); return "done"; }, "gave up")).resolves.toBe("done");
    calls = 0;
    await expect(retryWhenPersonsChange(async () => { calls += 1; throw new PersonsChanged(); }, "gave up")).resolves.toBe("gave up");
    expect(calls).toBe(3);
    await expect(retryWhenPersonsChange(async () => { throw new Error("database down"); }, "gave up")).rejects.toThrow("database down");
  });
});
