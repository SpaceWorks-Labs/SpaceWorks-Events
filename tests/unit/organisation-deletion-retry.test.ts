import { describe, expect, it, vi } from "vitest";
import { retryOrganisationDeletion } from "@/lib/organisationDeletionRetry";

describe("organisation deletion transaction retries", () => {
  it.each([
    { code: "P2034" },
    { code: "40P01" },
    { code: "40001" },
    { code: "P2010", meta: { code: "40P01", message: "deadlock detected" } },
    new Error("database error: SQLSTATE 40001"),
    new Error("Transaction failed", { cause: { code: "40P01" } }),
  ])("re-runs the whole transaction after an aborted attempt: %s", async (error) => {
    const transaction = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(null);
    await expect(retryOrganisationDeletion(transaction)).resolves.toBeNull();
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("makes at most three attempts and preserves the last failure", async () => {
    const last = { code: "P2034" };
    const transaction = vi.fn().mockRejectedValueOnce({ code: "40P01" }).mockRejectedValueOnce({ code: "40001" }).mockRejectedValue(last);
    await expect(retryOrganisationDeletion(transaction)).rejects.toBe(last);
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it.each([new Error("connection closed"), { code: "P2003" }, { code: "P2028" }, { code: "240001" }])("preserves unrelated errors without retrying: %s", async (error) => {
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(retryOrganisationDeletion(transaction)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("does not retry a returned obligations refusal", async () => {
    const transaction = vi.fn().mockResolvedValue("Refunds are still on their way to buyers.");
    await expect(retryOrganisationDeletion(transaction)).resolves.toBe("Refunds are still on their way to buyers.");
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
