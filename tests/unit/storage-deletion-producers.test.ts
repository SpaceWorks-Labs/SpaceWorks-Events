import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => vi.fn());
vi.mock("@/lib/storage/deletionQueue", () => ({ queueAssetDeletions: queue }));

import { deleteFiles } from "@/lib/storage";
import { deleteReceipts } from "@/lib/storage/private";

const id = "123e4567-e89b-42d3-a456-426614174000";
beforeEach(() => queue.mockReset());

describe("replacement storage deletions", () => {
  it("queues only unique public derivative keys, including covers and logos", async () => {
    const cover = `organisations/org/event-covers/${id}.webp`;
    const logo = `organisations/org/organisation-logos/${id}.webp`;
    await deleteFiles([cover, logo, cover, `organisations/org/claim-receipts/${id}.webp`, "backups/arbitrary"]);
    expect(queue).toHaveBeenCalledExactlyOnceWith([cover, logo]);
  });

  it("queues only unique receipt keys", async () => {
    const receipt = `organisations/org/claim-receipts/${id}.webp`;
    await deleteReceipts([receipt, receipt, `organisations/org/event-covers/${id}.webp`, "backups/arbitrary"]);
    expect(queue).toHaveBeenCalledExactlyOnceWith([receipt]);
  });

  it("ignores empty or invalid input without writing queue rows", async () => {
    await deleteFiles([]);
    await deleteReceipts(["arbitrary"]);
    expect(queue).not.toHaveBeenCalled();
  });
});
