import "server-only";

/** Prisma may wrap PostgreSQL SQLSTATEs in a raw-query error's metadata or cause. */
function retryable(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error === "string") return /\b(?:40P01|40001)\b/.test(error);
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  const details = error as { code?: unknown; message?: unknown; meta?: unknown; cause?: unknown };
  return details.code === "P2034"
    || retryable(details.message, seen)
    || retryable(details.cause, seen)
    || Object.values(error).some((value) => retryable(value, seen));
}

/**
 * Only organisation deletion retries this lock inversion: other Event-locked
 * commands can acquire Organisation key share later through a foreign key.
 * `transaction` must include every check and queued side effect, so an aborted
 * attempt rolls all of them back before the whole transaction runs again.
 */
export async function retryOrganisationDeletion<T>(transaction: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await transaction();
    } catch (error) {
      if (attempt >= 3 || !retryable(error)) throw error;
    }
  }
}
