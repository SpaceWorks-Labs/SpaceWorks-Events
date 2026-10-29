import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sqlUtcTimestamp, SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { currentStorageLocation, deleteObjects, listObjectsPage, objectRemains } from "./objects";

/*
 * The storage deletion queue's worker and producers (StorageDeletion in
 * prisma/schema.prisma; docs/CONFIGURATION.md "Object storage"). Every step is
 * safe to repeat: deleting an object twice is harmless, and a row goes only
 * after a later check finds no version of its object left. Each claim
 * increments `attempts`, and every write that finishes a claimed row requires
 * that value, so a worker delayed past its lease cannot overwrite the progress
 * of the worker that claimed the row after it.
 */

const BATCH = 100;
/** A claimed row is retried after this if its worker never finished. */
const LEASE_MS = 10 * 60_000;
/** How long after a DELETE the object is checked again. */
export const VERIFY_AFTER_MS = 24 * 60 * 60_000;
/** Prefix listings wait this long after the protocol epoch: the old-writer drain (1 h) plus the late-write bound (26 h). */
export const PREFIX_DELAY_MS = 27 * 60 * 60_000;
/** Receipts no claim refers to are removed after a day. */
export const UNATTACHED_RECEIPT_MS = 24 * 60 * 60_000;

type Tx = Prisma.TransactionClient;
type Row = { id: string; kind: "OBJECT" | "PREFIX"; state: "PENDING" | "CLAIMED" | "VERIFYING"; location: string; key: string; organisationId: string | null; continuationToken: string | null; attempts: number; lastErrorCode: string | null };

/**
 * Detach replaced/deleted assets and queue their objects atomically, without
 * calling storage from the request. UNATTACHED also covers these files whose
 * references have already gone. Keep S3 records if their location is unknown.
 */
export async function queueAssetDeletions(keys: string[]) {
  if (keys.length === 0) return;
  const location = currentStorageLocation();
  await prisma.$executeRaw`
    WITH gone AS (
      DELETE FROM "Asset" WHERE "key" = ANY(${keys}::text[])
        AND (${location}::text IS NOT NULL OR "provider" <> 's3')
      RETURNING "key", "organisationId", "provider"
    )
    INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
    SELECT gen_random_uuid()::text, 'OBJECT', ${location}, g."key", g."organisationId", 'UNATTACHED', ${SQL_UTC_NOW}, ${SQL_UTC_NOW}
    FROM gone g WHERE g."provider" = 's3'
    ON CONFLICT ("location", "key", "kind") DO NOTHING`;
}

/**
 * Inside the organisation-deletion transaction, with the organisation row
 * locked: queue every object-storage Asset of the organisation (images,
 * receipts, unused uploads), every expense receipt key, and one listing of its
 * legacy prefix. An upload still in progress keeps its own row (deadline,
 * state and fencing) because inserts never change an existing row.
 */
export async function queueOrganisationStorage(tx: Tx, organisationId: string, now = new Date()) {
  const location = currentStorageLocation();
  if (!location) return;
  const at = sqlUtcTimestamp(now);
  await tx.$executeRaw`
    INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
    SELECT gen_random_uuid()::text, 'OBJECT', ${location}, a."key", ${organisationId}, 'ORG_DELETED', ${at}, ${SQL_UTC_NOW}
    FROM "Asset" a WHERE a."organisationId" = ${organisationId} AND a."provider" = 's3'
    ON CONFLICT ("location", "key", "kind") DO NOTHING`;
  await tx.$executeRaw`
    INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
    SELECT gen_random_uuid()::text, 'OBJECT', ${location}, r."storageKey", ${organisationId}, 'ORG_DELETED', ${at}, ${SQL_UTC_NOW}
    FROM "ExpenseReceipt" r JOIN "ExpenseClaim" c ON c."id" = r."claimId"
    WHERE c."organisationId" = ${organisationId}
      AND NOT EXISTS (SELECT 1 FROM "Asset" a WHERE a."key" = r."storageKey" AND a."provider" <> 's3')
    ON CONFLICT ("location", "key", "kind") DO NOTHING`;
  // Objects an earlier release may have left without an Asset row. Listed no
  // earlier than the old-writer drain plus the late-write bound.
  await tx.$executeRaw`
    INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
    VALUES (gen_random_uuid()::text, 'PREFIX', ${location}, ${`organisations/${organisationId}/`}, ${organisationId}, 'LEGACY_PREFIX',
      GREATEST(${at}, coalesce((SELECT "enabledAt" FROM "StorageProtocol" WHERE "id" = 1), ${at}) + ${Prisma.raw(`interval '${PREFIX_DELAY_MS / 1000} seconds'`)}),
      ${SQL_UTC_NOW})
    ON CONFLICT ("location", "key", "kind") DO NOTHING`;
}

/**
 * Receipt photos no expense claim refers to, older than a day (an upload
 * whose claim was never saved): the Asset goes and, in the same statement, its
 * object is queued. Referenced receipts are never touched.
 */
export async function purgeUnattachedReceipts(now = new Date(), limit = 500) {
  const location = currentStorageLocation();
  const before = sqlUtcTimestamp(new Date(now.getTime() - UNATTACHED_RECEIPT_MS));
  const rows = await prisma.$queryRaw<Array<{ removed: number }>>`
    WITH gone AS (
      DELETE FROM "Asset" a WHERE a."id" IN (
        SELECT x."id" FROM "Asset" x
        WHERE x."key" LIKE 'organisations/%/claim-receipts/%' AND x."createdAt" < ${before}
          AND NOT EXISTS (SELECT 1 FROM "ExpenseReceipt" r WHERE r."storageKey" = x."key")
          AND (${location}::text IS NOT NULL OR x."provider" <> 's3')
        ORDER BY x."createdAt" LIMIT ${limit}
      )
      RETURNING a."key", a."organisationId", a."provider"
    ), queued AS (
      INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
      SELECT gen_random_uuid()::text, 'OBJECT', ${location}, g."key", g."organisationId", 'UNATTACHED', ${sqlUtcTimestamp(now)}, ${SQL_UTC_NOW}
      FROM gone g WHERE g."provider" = 's3'
      ON CONFLICT ("location", "key", "kind") DO NOTHING
    )
    SELECT count(*)::int AS "removed" FROM gone`;
  return rows[0]?.removed ?? 0;
}

/** A short, safe code for an error: never a message, key or URL. */
function errorCode(error: unknown) {
  const name = (error as { Code?: unknown; name?: unknown })?.Code ?? (error as { name?: unknown })?.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,62}$/.test(name) ? name : "Error";
}

function backoff(attempts: number) {
  return Math.min(2 ** Math.min(attempts, 9) * 60_000, 6 * 60 * 60_000);
}

async function retryLater(row: Row, now: Date, code: string) {
  await prisma.$executeRaw`
    UPDATE "StorageDeletion" SET "notBefore" = ${sqlUtcTimestamp(new Date(now.getTime() + backoff(row.attempts)))}, "lastErrorCode" = ${code}
    WHERE "id" = ${row.id} AND "attempts" = ${row.attempts}`;
}

/**
 * Claim due rows in one short statement before any request to storage: a
 * PENDING upload row becomes CLAIMED and can never be published, and each
 * claimed row is leased so a crashed worker's rows come back later.
 */
async function claimDue(now: Date) {
  return prisma.$queryRaw<Row[]>`
    UPDATE "StorageDeletion" d
    SET "state" = CASE WHEN d."state" = 'PENDING' THEN 'CLAIMED'::"StorageDeletionState" ELSE d."state" END,
        "notBefore" = ${sqlUtcTimestamp(new Date(now.getTime() + LEASE_MS))},
        "attempts" = d."attempts" + 1
    WHERE d."id" IN (
      SELECT "id" FROM "StorageDeletion" WHERE "notBefore" <= ${sqlUtcTimestamp(now)}
      ORDER BY "notBefore" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED
    )
    RETURNING d."id", d."kind"::text AS "kind", d."state"::text AS "state", d."location", d."key", d."organisationId",
      d."continuationToken", d."attempts", d."lastErrorCode"`;
}

async function deleteClaimed(rows: Row[], now: Date) {
  if (rows.length === 0) return 0;
  let failures: Map<string, string>;
  try {
    failures = await deleteObjects(rows.map((row) => row.key));
  } catch (error) {
    for (const row of rows) await retryLater(row, now, errorCode(error));
    return 0;
  }
  const verifyAt = sqlUtcTimestamp(new Date(now.getTime() + VERIFY_AFTER_MS));
  for (const row of rows) {
    const failure = failures.get(row.key);
    if (failure) await retryLater(row, now, errorCode({ Code: failure }));
    else await prisma.$executeRaw`
      UPDATE "StorageDeletion" SET "state" = 'VERIFYING', "notBefore" = ${verifyAt}, "lastErrorCode" = NULL
      WHERE "id" = ${row.id} AND "state" = 'CLAIMED' AND "attempts" = ${row.attempts}`;
  }
  return rows.length - failures.size;
}

async function verify(row: Row, now: Date) {
  if (!(await objectRemains(row.key))) {
    await prisma.$executeRaw`DELETE FROM "StorageDeletion" WHERE "id" = ${row.id} AND "state" = 'VERIFYING' AND "attempts" = ${row.attempts}`;
    return true;
  }
  // Still there: a late write, or a retention setting keeping it. Delete again and look again later.
  const failure = (await deleteObjects([row.key])).get(row.key);
  const code = failure ? errorCode({ Code: failure }) : row.lastErrorCode?.startsWith("STILL_PRESENT") ? "STILL_PRESENT_REPEATED" : "STILL_PRESENT";
  await prisma.$executeRaw`
    UPDATE "StorageDeletion" SET "notBefore" = ${sqlUtcTimestamp(new Date(now.getTime() + VERIFY_AFTER_MS))}, "lastErrorCode" = ${code}
    WHERE "id" = ${row.id} AND "attempts" = ${row.attempts}`;
  return false;
}

/** One page of a prefix listing: its keys queued and the next token saved together, unless another worker has claimed the row since. */
async function listPrefixPage(row: Row, now: Date) {
  const page = await listObjectsPage(row.key, row.continuationToken);
  return prisma.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "StorageDeletion" WHERE "id" = ${row.id} AND "attempts" = ${row.attempts} FOR UPDATE`;
    if (owned.length === 0) return 0;
    if (page.keys.length > 0) {
      await tx.$executeRaw`
        INSERT INTO "StorageDeletion" ("id", "kind", "location", "key", "organisationId", "reason", "notBefore", "createdAt")
        SELECT gen_random_uuid()::text, 'OBJECT', ${row.location}, k, ${row.organisationId}, 'LEGACY_PREFIX', ${sqlUtcTimestamp(now)}, ${SQL_UTC_NOW}
        FROM unnest(${page.keys}::text[]) AS k
        ON CONFLICT ("location", "key", "kind") DO NOTHING`;
    }
    // The listing is done; the objects it found finish on their own rows.
    if (page.next === null) await tx.$executeRaw`DELETE FROM "StorageDeletion" WHERE "id" = ${row.id}`;
    else await tx.$executeRaw`
      UPDATE "StorageDeletion" SET "continuationToken" = ${page.next}, "notBefore" = ${sqlUtcTimestamp(now)}, "lastErrorCode" = NULL
      WHERE "id" = ${row.id}`;
    return page.keys.length;
  });
}

/** The beat job: one batch of due deletions, verifications and listing pages. */
export async function processStorageDeletions(now = new Date()) {
  const result = { deleted: 0, verified: 0, listed: 0, failed: 0, misplaced: 0 };
  const location = currentStorageLocation();
  if (!location) return result;
  const rows = await claimDue(now);
  const toDelete: Row[] = [];
  for (const row of rows) {
    if (row.location !== location) {
      // Never deleted against another bucket: kept and shown on the Operations page.
      result.misplaced += 1;
      await prisma.$executeRaw`
        UPDATE "StorageDeletion" SET "notBefore" = ${sqlUtcTimestamp(new Date(now.getTime() + VERIFY_AFTER_MS))}, "lastErrorCode" = 'LOCATION_MISMATCH'
        WHERE "id" = ${row.id} AND "attempts" = ${row.attempts}`;
    } else if (row.kind === "OBJECT" && row.state === "CLAIMED") {
      toDelete.push(row);
    } else {
      try {
        if (row.kind === "PREFIX") result.listed += await listPrefixPage(row, now);
        else if (await verify(row, now)) result.verified += 1;
      } catch (error) {
        result.failed += 1;
        await retryLater(row, now, errorCode(error));
      }
    }
  }
  const deleted = await deleteClaimed(toDelete, now);
  result.deleted += deleted;
  result.failed += toDelete.length - deleted;
  return result;
}

/** What the Operations page warns about: rows for another storage location, objects that keep coming back, and repeated failures. */
export async function storageDeletionProblems() {
  const [row] = await prisma.$queryRaw<Array<{ misplaced: number; stillPresent: number; failing: number; pending: number }>>`
    SELECT count(*) FILTER (WHERE "lastErrorCode" = 'LOCATION_MISMATCH')::int AS "misplaced",
           count(*) FILTER (WHERE "lastErrorCode" = 'STILL_PRESENT_REPEATED')::int AS "stillPresent",
           count(*) FILTER (WHERE "attempts" >= 5 AND "lastErrorCode" IS NOT NULL
             AND "lastErrorCode" NOT IN ('LOCATION_MISMATCH', 'STILL_PRESENT', 'STILL_PRESENT_REPEATED'))::int AS "failing",
           count(*) FILTER (WHERE "reason" <> 'UPLOAD_PENDING')::int AS "pending"
    FROM "StorageDeletion"`;
  return row ?? { misplaced: 0, stillPresent: 0, failing: 0, pending: 0 };
}
