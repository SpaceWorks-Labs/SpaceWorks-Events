import "server-only";

function sqlState(code: unknown): boolean {
  return code === "40P01" || code === "40001";
}

function errorDetails(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function sqlStateMessage(message: unknown): boolean {
  return typeof message === "string" && (
    /\bSQLSTATE(?:\s*[:=]\s*|\s+)[`"']?(?:40P01|40001)\b/.test(message)
    || /\bCode:\s*`(?:40P01|40001)`/.test(message)
    // Prisma's Rust engine exposes some interactive-transaction failures only
    // in UnknownRequestError.message, including the typed PostgreSQL error.
    || /\bPostgresError\s*\{\s*code:\s*"(?:40P01|40001)"/.test(message)
  );
}

/** Inspect only Prisma/driver error fields and explicit causes, never arbitrary metadata. */
function retryable(error: unknown, seen = new Set<object>()): boolean {
  if (typeof error === "string") return sqlStateMessage(error);
  const details = errorDetails(error);
  if (!details || seen.has(details)) return false;
  seen.add(details);
  const meta = errorDetails(details.meta);
  const driver = errorDetails(meta?.driverAdapterError);
  const driverCause = errorDetails(driver?.cause);
  return details.code === "P2034"
    || sqlState(details.code)
    || sqlState(meta?.code)
    // Prisma 6's JS engine wraps raw-query DriverAdapterError here.
    || sqlState(driverCause?.originalCode)
    || sqlStateMessage(details.message)
    || retryable(details.cause, seen)
    || retryable(driver, seen);
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
