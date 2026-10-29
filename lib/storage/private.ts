import "server-only";

import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { client, storageConfigured } from "./objects";
import { uploadObject } from "./uploads";

/**
 * Private files: expense claim receipts (docs/FINANCE.md). They never go
 * through `/api/uploads` (which serves only public derivatives, see
 * isPublicDerivativeKey); a route checks who may see each one. Receipts are
 * re-encoded WebP photos, stored with `private, no-store`.
 */

const RECEIPT_KEY = /^organisations\/([A-Za-z0-9_-]{1,128})\/claim-receipts\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;

export function isReceiptKey(key: string) {
  return RECEIPT_KEY.test(key);
}

export function newReceiptKey(organisationId: string) {
  return `organisations/${organisationId}/claim-receipts/${randomUUID()}.webp`;
}

/** Store a receipt photo under its organisation's private prefix. */
export async function uploadReceipt(organisationId: string, key: string, body: Buffer) {
  if (RECEIPT_KEY.exec(key)?.[1] !== organisationId) throw new Error("Invalid receipt storage key.");
  const contentType = "image/webp";
  if (storageConfigured()) {
    // Tracked from before the PUT until the Asset exists (lib/storage/uploads.ts).
    await uploadObject({ key, organisationId, body, contentType, cacheControl: "private, no-store" });
    return;
  }
  if (process.env.NODE_ENV === "production") throw new Error("Private object storage is not configured.");
  await prisma.asset.upsert({
    where: { key },
    create: { key, contentType, byteSize: BigInt(body.length), provider: "database", fileData: new Uint8Array(body), organisationId },
    update: { contentType, byteSize: BigInt(body.length), provider: "database", fileData: new Uint8Array(body), organisationId },
  });
}

/** The bytes of a receipt; the caller has already checked who may see it. */
export async function downloadReceipt(key: string) {
  if (!isReceiptKey(key)) return null;
  const asset = await prisma.asset.findUnique({ where: { key }, select: { provider: true, fileData: true } });
  if (!asset) return null;
  if (asset.provider === "s3") {
    if (!storageConfigured()) throw new Error("Private object storage is not configured.");
    const object = await client().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return object.Body ? await object.Body.transformToByteArray() : null;
  }
  return asset.fileData ?? null;
}

/** Remove receipts (best effort, after the rows that referenced them are gone). */
export async function deleteReceipts(keys: string[]) {
  const valid = [...new Set(keys.filter(isReceiptKey))];
  if (valid.length === 0) return;
  const stored = await prisma.asset.findMany({ where: { key: { in: valid }, provider: "s3" }, select: { key: true } });
  if (stored.length > 0 && storageConfigured()) {
    await client().send(new DeleteObjectsCommand({ Bucket: process.env.S3_BUCKET!, Delete: { Objects: stored.map(({ key }) => ({ Key: key })), Quiet: true } }));
  }
  await prisma.asset.deleteMany({ where: { key: { in: valid } } });
}
