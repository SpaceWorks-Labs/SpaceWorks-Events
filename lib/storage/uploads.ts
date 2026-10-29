import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sqlUtcTimestamp, SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { currentStorageLocation, putObject } from "./objects";

/*
 * Every object-storage upload in three steps (docs/CONFIGURATION.md "Object
 * storage"), so no object can outlive a failed, abandoned or uncertain PUT:
 *  1. register: a PENDING deletion row for the fresh key, before any byte is
 *     sent (a key already in use, by a row or an Asset, aborts the attempt);
 *  2. put: refused from the deadline on, and aborted when it comes;
 *  3. publish: removing our own row while it is still PENDING, and creating
 *     the Asset, in one transaction. A row the deletion worker has claimed
 *     can never be published, so the worker and a late publisher cannot both
 *     win; the Asset's organisation foreign key fails once it is deleted.
 * A failure anywhere leaves the row, and the beat deletes the object after
 * the deadline plus a grace period (lib/storage/deletionQueue.ts).
 */

export const UPLOAD_WINDOW_MS = 30 * 60_000;
export const UPLOAD_GRACE_MS = 2 * 60 * 60_000;

export type RegisteredUpload = { id: string; key: string; deadline: Date };

export async function registerUpload(key: string, organisationId: string | null, now = new Date()): Promise<RegisteredUpload> {
  const location = currentStorageLocation();
  if (!location) throw new Error("Private object storage is not configured.");
  const id = randomUUID();
  const deadline = new Date(now.getTime() + UPLOAD_WINDOW_MS);
  const notBefore = new Date(deadline.getTime() + UPLOAD_GRACE_MS);
  const registered = await prisma.$executeRaw`
    INSERT INTO "StorageDeletion" ("id", "kind", "state", "location", "key", "organisationId", "reason", "deadline", "notBefore", "createdAt")
    SELECT ${id}, 'OBJECT', 'PENDING', ${location}, ${key}, ${organisationId}, 'UPLOAD_PENDING', ${sqlUtcTimestamp(deadline)}, ${sqlUtcTimestamp(notBefore)}, ${SQL_UTC_NOW}
    WHERE NOT EXISTS (SELECT 1 FROM "Asset" WHERE "key" = ${key})
    ON CONFLICT ("location", "key", "kind") DO NOTHING`;
  if (registered !== 1) throw new Error("This storage key is already in use.");
  return { id, key, deadline };
}

export async function putRegistered(
  upload: RegisteredUpload,
  object: { body: Buffer; contentType: string; cacheControl: string },
  now = new Date(),
) {
  const remaining = upload.deadline.getTime() - now.getTime();
  if (remaining <= 0) throw new Error("The upload did not start in time.");
  await putObject({ key: upload.key, ...object, abortSignal: AbortSignal.timeout(remaining) });
}

export async function publishUpload(upload: RegisteredUpload, asset: Prisma.AssetUncheckedCreateInput) {
  await prisma.$transaction(async (tx) => {
    const released = await tx.$executeRaw`DELETE FROM "StorageDeletion" WHERE "id" = ${upload.id} AND "state" = 'PENDING'`;
    if (released !== 1) throw new Error("The upload expired before it was saved.");
    await tx.asset.create({ data: { ...asset, key: upload.key } });
  });
}

/** Register, put and publish one object; any failure leaves the object queued for deletion. */
export async function uploadObject(input: {
  key: string;
  organisationId: string | null;
  body: Buffer;
  contentType: string;
  cacheControl: string;
}) {
  const upload = await registerUpload(input.key, input.organisationId);
  await putRegistered(upload, { body: input.body, contentType: input.contentType, cacheControl: input.cacheControl });
  await publishUpload(upload, {
    key: input.key,
    contentType: input.contentType,
    byteSize: BigInt(input.body.length),
    provider: "s3",
    organisationId: input.organisationId,
  });
}
