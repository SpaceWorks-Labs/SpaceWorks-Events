import "server-only";

import { createHash } from "node:crypto";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/*
 * The object-storage calls the upload protocol and the deletion queue make
 * (lib/storage/uploads.ts, lib/storage/deletionQueue.ts), against the
 * configured private bucket.
 */

export function storageConfigured() {
  return Boolean(process.env.S3_BUCKET && process.env.S3_REGION);
}

export function client() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  return new S3Client({
    region: process.env.S3_REGION!,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT } : {}),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1",
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
}

/**
 * A stable id for where objects live now: the provider, endpoint and bucket,
 * hashed (no credentials). Deletion rows record it, and the worker never
 * deletes a row's key in another location. Null without object storage.
 */
export function currentStorageLocation(): string | null {
  if (!storageConfigured()) return null;
  const endpoint = (process.env.S3_ENDPOINT?.trim() || `aws:${process.env.S3_REGION}`).replace(/\/+$/, "").toLowerCase();
  return `s3:${createHash("sha256").update(`${endpoint}\n${process.env.S3_BUCKET}`).digest("hex").slice(0, 32)}`;
}

export async function putObject(input: { key: string; body: Buffer; contentType: string; cacheControl: string; abortSignal: AbortSignal }) {
  await client().send(
    new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: input.key, Body: input.body, ContentType: input.contentType, CacheControl: input.cacheControl }),
    { abortSignal: input.abortSignal },
  );
}

/** DELETE each key (a missing key counts as deleted). Returns the keys that failed, with the provider's error code. */
export async function deleteObjects(keys: string[]): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  for (let start = 0; start < keys.length; start += 1000) {
    const result = await client().send(new DeleteObjectsCommand({
      Bucket: process.env.S3_BUCKET!,
      Delete: { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
    for (const error of result.Errors ?? []) {
      if (error.Key && error.Code !== "NoSuchKey") failed.set(error.Key, error.Code ?? "DeleteFailed");
    }
  }
  return failed;
}

/** Whether the object exists (a HEAD request). */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await client().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as Error).name === "NotFound" || (error as Error).name === "NoSuchKey") return false;
    throw error;
  }
}

/** One page of keys under a prefix, and where the next page starts (null at the end). */
export async function listObjectsPage(prefix: string, continuationToken: string | null): Promise<{ keys: string[]; next: string | null }> {
  const page = await client().send(new ListObjectsV2Command({
    Bucket: process.env.S3_BUCKET!,
    Prefix: prefix,
    MaxKeys: 1000,
    ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
  }));
  return {
    keys: (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])),
    next: page.IsTruncated ? page.NextContinuationToken ?? null : null,
  };
}
