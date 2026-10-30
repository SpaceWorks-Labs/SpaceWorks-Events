import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { retryOrganisationDeletion } from "@/lib/organisationDeletionRetry";

describe("organisation deletion transaction retries", () => {
  it.each([
    { code: "P2034" },
    { code: "40P01" },
    { code: "40001" },
    { code: "P2010", meta: { code: "40P01", message: "deadlock detected" } },
    { code: "P2010", meta: { code: "40001" } },
    new Error("database error: SQLSTATE 40001"),
    new Error("database error: SQLSTATE 40P01"),
    new Error("Transaction failed", { cause: { code: "40P01" } }),
    new Error("Transaction failed", { cause: new Error("Driver failed", { cause: { code: "40001" } }) }),
    new Prisma.PrismaClientKnownRequestError("Transaction write conflict", {
      code: "P2034", clientVersion: Prisma.prismaVersion.client,
    }),
    new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010", clientVersion: Prisma.prismaVersion.client, meta: { code: "40P01" },
    }),
    new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010", clientVersion: Prisma.prismaVersion.client,
      meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: "40P01" } } },
    }),
    new Prisma.PrismaClientUnknownRequestError('QueryError(PostgresError { code: "40P01", message: "deadlock detected" })', {
      clientVersion: Prisma.prismaVersion.client,
    }),
    new Prisma.PrismaClientUnknownRequestError("Raw query failed. Code: `40001`. Message: `serialization failure`", {
      clientVersion: Prisma.prismaVersion.client,
    }),
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

  it.each([
    new Error("connection closed"), { code: "P2003" }, { code: "P2028" }, { code: "240001" },
    { code: "P1001", message: "Cannot connect to database server at localhost:40001" },
    new Error("Unrelated reference 40P01 in plain text"),
    { code: "P1001", meta: { port: "40001", message: "Reference 40P01" } },
    { code: "P2003", context: { code: "40P01" }, meta: { detail: "SQLSTATE 40001" } },
    { code: "40001-extra" },
    new Error("SQLSTATE 400010"),
    new Error("Raw query failed. Code: `40P010`"),
    new Error("Driver failed", { cause: new Error("Cannot connect to port 40001") }),
  ])("preserves unrelated errors without retrying: %s", async (error) => {
    const transaction = vi.fn().mockRejectedValue(error);
    await expect(retryOrganisationDeletion(transaction)).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("handles cyclic causes without retrying unrelated failures", async () => {
    const error = new Error("connection closed");
    error.cause = error;
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
