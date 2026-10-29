import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVersionedS3 } from "@/tests/helpers/fakeVersionedS3";

const fake = vi.hoisted(() => ({ s3: null as null | ReturnType<typeof fakeVersionedS3> }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send(command: unknown) { return Promise.resolve().then(() => fake.s3!.send(command)); } } };
});

import * as sdk from "@aws-sdk/client-s3";
import { deleteObjects, listObjectsPage, objectRemains } from "@/lib/storage/objects";

let bucketNumber = 0;
beforeEach(() => {
  // A fresh bucket name is a fresh storage location (the versions-API note is kept per location).
  vi.stubEnv("S3_BUCKET", `versions-${++bucketNumber}`);
  vi.stubEnv("S3_REGION", "auto");
  vi.stubEnv("S3_ENDPOINT", "https://storage.example.test");
  fake.s3 = fakeVersionedS3(sdk);
});
afterAll(() => vi.unstubAllEnvs());

async function listAll(prefix: string) {
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const page: { keys: string[]; next: string | null } = await listObjectsPage(prefix, token);
    keys.push(...page.keys);
    token = page.next;
  } while (token);
  return [...new Set(keys)].sort();
}

describe("version-aware object deletion", () => {
  it("removes every version and delete marker of a key, and only of that key", async () => {
    const s3 = fake.s3!;
    s3.bucket.pageSize = 2;
    s3.put("organisations/o/receipt.webp");
    s3.put("organisations/o/receipt.webp");
    s3.deleteKey("organisations/o/receipt.webp");
    s3.put("organisations/o/receipt.webp");
    s3.put("organisations/o/receipt.webp.bak");
    expect(await objectRemains("organisations/o/receipt.webp")).toBe(true);
    expect(await deleteObjects(["organisations/o/receipt.webp"])).toEqual(new Map());
    expect(s3.keys()).toEqual(["organisations/o/receipt.webp.bak"]);
    expect(await objectRemains("organisations/o/receipt.webp")).toBe(false);
    expect(await objectRemains("organisations/o/receipt.webp.bak")).toBe(true);
  });

  it("treats a key that only a delete marker holds as still present until the marker goes", async () => {
    const s3 = fake.s3!;
    s3.put("organisations/o/cover.webp");
    s3.deleteKey("organisations/o/cover.webp");
    // HEAD would say 404 here, yet the bytes are kept.
    expect(await objectRemains("organisations/o/cover.webp")).toBe(true);
    await deleteObjects(["organisations/o/cover.webp"]);
    expect(s3.keys()).toEqual([]);
  });

  it("finds keys under a prefix that only old versions or a delete marker still hold, across pages", async () => {
    const s3 = fake.s3!;
    s3.bucket.pageSize = 2;
    for (const name of ["a", "b", "c"]) s3.put(`organisations/o/${name}.webp`);
    s3.put("organisations/o/b.webp");
    s3.deleteKey("organisations/o/a.webp");
    s3.deleteKey("organisations/o/c.webp");
    s3.put("organisations/other/z.webp");
    expect(await listAll("organisations/o/")).toEqual(["organisations/o/a.webp", "organisations/o/b.webp", "organisations/o/c.webp"]);
    await deleteObjects(await listAll("organisations/o/"));
    expect(s3.keys()).toEqual(["organisations/other/z.webp"]);
  });

  it("deletes the single version an unversioned bucket keeps", async () => {
    const s3 = fake.s3!;
    s3.bucket.versioning = "off";
    s3.put("organisations/o/a.webp");
    s3.put("organisations/o/a.webp");
    await deleteObjects(["organisations/o/a.webp"]);
    expect(s3.keys()).toEqual([]);
    expect(await objectRemains("organisations/o/a.webp")).toBe(false);
  });

  it("falls back to plain deletes, HEAD and ListObjectsV2 when the provider has no versions API, asking once per location", async () => {
    const s3 = fake.s3!;
    s3.bucket.versioning = "unsupported";
    s3.bucket.pageSize = 1;
    s3.put("organisations/o/a.webp");
    s3.put("organisations/o/b.webp");
    expect(await listAll("organisations/o/")).toEqual(["organisations/o/a.webp", "organisations/o/b.webp"]);
    expect(await objectRemains("organisations/o/a.webp")).toBe(true);
    expect(await deleteObjects(["organisations/o/a.webp", "organisations/o/b.webp"])).toEqual(new Map());
    expect(await objectRemains("organisations/o/a.webp")).toBe(false);
    expect(s3.keys()).toEqual([]);
    expect(s3.bucket.versionLists).toBe(1);
  });

  it("keeps a permission error a failure, and does not fall back for it", async () => {
    const s3 = fake.s3!;
    s3.put("organisations/o/a.webp");
    s3.bucket.failListWith = Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await expect(deleteObjects(["organisations/o/a.webp"])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(objectRemains("organisations/o/a.webp")).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(listObjectsPage("organisations/o/", null)).rejects.toMatchObject({ name: "AccessDenied" });
    expect(s3.keys()).toEqual(["organisations/o/a.webp"]);
    // Once permitted, the versions API is used again: nothing fell back.
    s3.bucket.failListWith = null;
    await deleteObjects(["organisations/o/a.webp"]);
    expect(s3.keys()).toEqual([]);
  });
});
