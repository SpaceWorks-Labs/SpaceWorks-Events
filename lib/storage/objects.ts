import "server-only";

import { createHash } from "node:crypto";
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  type ObjectIdentifier,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/*
 * The object-storage calls the upload protocol and the deletion queue make
 * (lib/storage/uploads.ts, lib/storage/deletionQueue.ts), against the
 * configured private bucket.
 *
 * Deleting is version-aware: on a bucket with versioning (bundled Silo keeps
 * it on) a plain delete only adds a delete marker and keeps the bytes, so
 * every version and delete marker of a key is listed (ListObjectVersions) and
 * deleted by version id. An unversioned bucket lists each object once, with
 * the version id "null". A provider without the versions API (Cloudflare R2
 * answers NotImplemented / 501) is noted once per storage location and uses
 * plain deletes, HEAD and ListObjectsV2 instead. Any other error, such as
 * AccessDenied or a network failure, is thrown to the caller as a failure.
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

/** Locations whose provider has no ListObjectVersions (noted the first time it answers NotImplemented / 501). */
const unversionedLocations = new Set<string>();

function versionsUnsupported(error: unknown) {
  const { name, Code, $metadata } = (error ?? {}) as { name?: unknown; Code?: unknown; $metadata?: { httpStatusCode?: number } };
  return name === "NotImplemented" || Code === "NotImplemented" || $metadata?.httpStatusCode === 501;
}

type VersionsPage = { entries: Array<{ key: string; versionId: string | undefined }>; truncated: boolean; nextKey: string | null; nextVersion: string | null };

/** One page of versions and delete markers under a prefix, or null when this provider has no versions API. */
async function listVersions(prefix: string, keyMarker: string | null, versionMarker: string | null): Promise<VersionsPage | null> {
  const location = currentStorageLocation();
  if (location && unversionedLocations.has(location)) return null;
  try {
    const page = await client().send(new ListObjectVersionsCommand({
      Bucket: process.env.S3_BUCKET!,
      Prefix: prefix,
      MaxKeys: 1000,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(keyMarker && versionMarker ? { VersionIdMarker: versionMarker } : {}),
    }));
    const entries = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .flatMap((entry) => (entry.Key ? [{ key: entry.Key, versionId: entry.VersionId }] : []));
    return { entries, truncated: Boolean(page.IsTruncated), nextKey: page.NextKeyMarker ?? null, nextVersion: page.NextVersionIdMarker ?? null };
  } catch (error) {
    if (!versionsUnsupported(error)) throw error;
    if (location) unversionedLocations.add(location);
    return null;
  }
}

/**
 * Every version and delete marker of exactly `key`, or null without a
 * versions API. The key itself is the first name under its own prefix, so the
 * listing stops at the first longer name.
 */
async function keyVersions(key: string): Promise<ObjectIdentifier[] | null> {
  const found: ObjectIdentifier[] = [];
  let marker: { key: string | null; version: string | null } = { key: null, version: null };
  for (;;) {
    const page = await listVersions(key, marker.key, marker.version);
    if (!page) return null;
    for (const entry of page.entries) {
      if (entry.key === key) found.push({ Key: key, VersionId: entry.versionId });
    }
    if (!page.truncated || page.entries.some((entry) => entry.key !== key) || !page.nextKey) return found;
    marker = { key: page.nextKey, version: page.nextVersion };
  }
}

async function deleteIdentifiers(objects: ObjectIdentifier[], failed: Map<string, string>) {
  for (let start = 0; start < objects.length; start += 1000) {
    const result = await client().send(new DeleteObjectsCommand({
      Bucket: process.env.S3_BUCKET!,
      Delete: { Objects: objects.slice(start, start + 1000), Quiet: true },
    }));
    for (const error of result.Errors ?? []) {
      if (error.Key && error.Code !== "NoSuchKey" && error.Code !== "NoSuchVersion") failed.set(error.Key, error.Code ?? "DeleteFailed");
    }
  }
}

/**
 * Delete every version and delete marker of each key (a missing key counts as
 * deleted). Returns the keys that failed, with the provider's error code.
 */
export async function deleteObjects(keys: string[]): Promise<Map<string, string>> {
  const failed = new Map<string, string>();
  const objects: ObjectIdentifier[] = [];
  for (const key of keys) {
    const versions = await keyVersions(key);
    if (versions) objects.push(...versions);
    else objects.push({ Key: key });
  }
  await deleteIdentifiers(objects, failed);
  return failed;
}

/** Whether anything of the key is left: any version or delete marker, or (without a versions API) the object itself by HEAD. */
export async function objectRemains(key: string): Promise<boolean> {
  const versions = await keyVersions(key);
  if (versions) return versions.length > 0;
  try {
    await client().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return true;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (error as Error).name === "NotFound" || (error as Error).name === "NoSuchKey") return false;
    throw error;
  }
}

const VERSIONS_TOKEN = "versions:";

/**
 * One page of keys under a prefix, and where the next page starts (null at
 * the end). With a versions API this includes keys that only old versions or
 * a delete marker still hold, which a plain listing would miss.
 */
export async function listObjectsPage(prefix: string, continuationToken: string | null): Promise<{ keys: string[]; next: string | null }> {
  const marker = continuationToken?.startsWith(VERSIONS_TOKEN) ? (JSON.parse(continuationToken.slice(VERSIONS_TOKEN.length)) as [string, string | null]) : null;
  const versions = await listVersions(prefix, marker?.[0] ?? null, marker?.[1] ?? null);
  if (versions) {
    return {
      keys: [...new Set(versions.entries.map((entry) => entry.key))],
      next: versions.truncated && versions.nextKey ? `${VERSIONS_TOKEN}${JSON.stringify([versions.nextKey, versions.nextVersion])}` : null,
    };
  }
  const page = await client().send(new ListObjectsV2Command({
    Bucket: process.env.S3_BUCKET!,
    Prefix: prefix,
    MaxKeys: 1000,
    ...(continuationToken && !marker ? { ContinuationToken: continuationToken } : {}),
  }));
  return {
    keys: (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : [])),
    next: page.IsTruncated ? page.NextContinuationToken ?? null : null,
  };
}
