import type * as S3 from "@aws-sdk/client-s3";

/*
 * An in-memory S3 bucket for the storage tests, answering the commands
 * lib/storage/objects.ts sends. `versioning` "on" keeps every version and
 * turns a plain delete into a delete marker (bundled Silo); "off" keeps one
 * "null" version per key; "unsupported" answers ListObjectVersions with
 * NotImplemented / 501 like Cloudflare R2. While `failListWith` is set,
 * versions listings throw it (for example AccessDenied).
 */

type Entry = { key: string; versionId: string; marker: boolean };

export function fakeVersionedS3(sdk: typeof S3) {
  const bucket = {
    versioning: "on" as "on" | "off" | "unsupported",
    entries: [] as Entry[],
    pageSize: 1000,
    failListWith: null as Error | null,
    versionLists: 0,
    sequence: 0,
  };

  const latest = (key: string) => bucket.entries.filter((entry) => entry.key === key).at(-1);
  const sorted = () => bucket.entries
    .map((entry, index) => ({ entry, index }))
    // By key, and newest first within a key, like S3.
    .sort((a, b) => (a.entry.key < b.entry.key ? -1 : a.entry.key > b.entry.key ? 1 : b.index - a.index))
    .map(({ entry }) => entry);

  function put(key: string) {
    if (bucket.versioning === "on") bucket.entries.push({ key, versionId: `v${++bucket.sequence}`, marker: false });
    else bucket.entries = [...bucket.entries.filter((entry) => entry.key !== key), { key, versionId: "null", marker: false }];
  }

  function deleteKey(key: string) {
    if (bucket.versioning === "on") bucket.entries.push({ key, versionId: `m${++bucket.sequence}`, marker: true });
    else bucket.entries = bucket.entries.filter((entry) => entry.key !== key);
  }

  function send(command: unknown): unknown {
    if (command instanceof sdk.ListObjectVersionsCommand) {
      bucket.versionLists += 1;
      if (bucket.versioning === "unsupported") {
        throw Object.assign(new Error("Not implemented"), { name: "NotImplemented", $metadata: { httpStatusCode: 501 } });
      }
      if (bucket.failListWith) throw bucket.failListWith;
      const { Prefix = "", KeyMarker, VersionIdMarker } = command.input;
      let all = sorted().filter((entry) => entry.key.startsWith(Prefix));
      if (KeyMarker) {
        const at = VersionIdMarker ? all.findIndex((entry) => entry.key === KeyMarker && entry.versionId === VersionIdMarker) : -1;
        all = at >= 0 ? all.slice(at + 1) : all.filter((entry) => entry.key > KeyMarker);
      }
      const page = all.slice(0, bucket.pageSize);
      const last = page.at(-1);
      const truncated = all.length > page.length;
      return {
        Versions: page.filter((entry) => !entry.marker).map((entry) => ({ Key: entry.key, VersionId: entry.versionId })),
        DeleteMarkers: page.filter((entry) => entry.marker).map((entry) => ({ Key: entry.key, VersionId: entry.versionId })),
        IsTruncated: truncated,
        ...(truncated && last ? { NextKeyMarker: last.key, NextVersionIdMarker: last.versionId } : {}),
      };
    }
    if (command instanceof sdk.DeleteObjectsCommand || command instanceof sdk.DeleteObjectCommand) {
      const objects = command instanceof sdk.DeleteObjectCommand ? [command.input] : command.input.Delete?.Objects ?? [];
      for (const { Key, VersionId } of objects) {
        if (!Key) continue;
        if (VersionId) bucket.entries = bucket.entries.filter((entry) => !(entry.key === Key && entry.versionId === VersionId));
        else deleteKey(Key);
      }
      return { Errors: [] };
    }
    if (command instanceof sdk.HeadObjectCommand) {
      const entry = latest(command.input.Key!);
      if (!entry || entry.marker) throw Object.assign(new Error("Not Found"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
      return {};
    }
    if (command instanceof sdk.ListObjectsV2Command) {
      const { Prefix = "", ContinuationToken } = command.input;
      const keys = [...new Set(sorted().map((entry) => entry.key))]
        .filter((key) => key.startsWith(Prefix) && !latest(key)!.marker && (!ContinuationToken || key > ContinuationToken));
      const page = keys.slice(0, bucket.pageSize);
      return { Contents: page.map((Key) => ({ Key })), IsTruncated: keys.length > page.length, NextContinuationToken: page.at(-1) };
    }
    if (command instanceof sdk.PutObjectCommand) {
      put(command.input.Key!);
      return {};
    }
    throw new Error("The fake bucket does not answer this command.");
  }

  /** Every key that still has a version or a delete marker. */
  const keys = () => [...new Set(bucket.entries.map((entry) => entry.key))].sort();
  return { bucket, put, deleteKey, send, keys };
}
