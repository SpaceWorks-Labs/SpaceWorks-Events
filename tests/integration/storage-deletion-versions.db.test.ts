import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeVersionedS3 } from "@/tests/helpers/fakeVersionedS3";

/*
 * The storage deletion queue end to end against a fake bucket with
 * versioning on (bundled Silo) and one without a versions API (Cloudflare
 * R2): a deleted organisation leaves no version, delete marker or queue row.
 */
const fake = vi.hoisted(() => ({ s3: null as null | ReturnType<typeof fakeVersionedS3> }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send(command: unknown) { return Promise.resolve().then(() => fake.s3!.send(command)); } } };
});

import * as sdk from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { deleteFiles, uploadFile } from "@/lib/storage";
import { deleteReceipts, uploadReceipt } from "@/lib/storage/private";
import { processStorageDeletions, queueOrganisationStorage, VERIFY_AFTER_MS } from "@/lib/storage/deletionQueue";

const HOUR = 60 * 60_000;
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
let enabledAt: Date;
let bucketNumber = 0;

beforeAll(async () => {
  vi.stubEnv("S3_REGION", "auto");
  vi.stubEnv("S3_ENDPOINT", "https://storage.example.test");
  enabledAt = (await prisma.storageProtocol.findUniqueOrThrow({ where: { id: 1 } })).enabledAt;
  // Past the legacy-prefix delay, so the prefix is listed straight away.
  await prisma.storageProtocol.update({ where: { id: 1 }, data: { enabledAt: new Date(Date.now() - 48 * HOUR) } });
});

beforeEach(async () => {
  await prisma.storageDeletion.deleteMany({});
  vi.stubEnv("S3_BUCKET", `versions-queue-${++bucketNumber}`);
  fake.s3 = fakeVersionedS3(sdk);
});

afterAll(async () => {
  await prisma.storageProtocol.update({ where: { id: 1 }, data: { enabledAt } });
  await prisma.storageDeletion.deleteMany({});
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

async function deleteOrganisationWithFiles() {
  const organisationId = (await prisma.organisation.create({ data: { name: "versions", slug: `versions-${randomUUID().slice(0, 8)}` } })).id;
  const cover = `organisations/${organisationId}/event-covers/${randomUUID()}.webp`;
  await uploadFile({ key: cover, body: Buffer.from("webp"), contentType: "image/webp", organisationId });
  // Replaced twice: three versions under one key.
  fake.s3!.put(cover);
  fake.s3!.put(cover);
  // Left by an earlier release without an Asset row, then deleted by key: only a delete marker shows.
  const hidden = `organisations/${organisationId}/event-covers/legacy-hidden.webp`;
  fake.s3!.put(hidden);
  fake.s3!.deleteKey(hidden);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${organisationId} FOR UPDATE`;
    await queueOrganisationStorage(tx, organisationId);
    await tx.organisation.delete({ where: { id: organisationId } });
  });
  return { cover, hidden };
}

async function runUntilDone() {
  const now = new Date();
  for (let pass = 0; pass < 3; pass += 1) await processStorageDeletions(now);
  await processStorageDeletions(later(now, VERIFY_AFTER_MS + HOUR));
}

describe.sequential("storage deletion queue with object versions", () => {
  it.each(["event-covers", "organisation-logos", "claim-receipts"])("queues a replaced %s file without calling S3, then removes every old version and marker", async (folder) => {
    const organisationId = (await prisma.organisation.create({ data: { name: "replacement", slug: `replacement-${randomUUID()}` } })).id;
    const key = `organisations/${organisationId}/${folder}/${randomUUID()}.webp`;
    const replacement = `organisations/${organisationId}/${folder}/${randomUUID()}.webp`;
    const upload = async (key: string) => folder === "claim-receipts"
      ? uploadReceipt(organisationId, key, Buffer.from("webp"))
      : uploadFile({ key, body: Buffer.from("webp"), contentType: "image/webp", organisationId });
    const remove = folder === "claim-receipts" ? deleteReceipts : deleteFiles;
    try {
      await upload(key);
      await upload(replacement);
      fake.s3!.put(key);
      fake.s3!.deleteKey(key);
      const entries = [...fake.s3!.bucket.entries];
      // External S3 permission failures must never reach a replacement request.
      fake.s3!.bucket.failListWith = Object.assign(new Error("denied"), { name: "AccessDenied" });
      await remove([key, key]);
      expect(fake.s3!.bucket.entries).toEqual(entries);
      expect(fake.s3!.bucket.versionLists).toBe(0);
      expect(await prisma.asset.findUnique({ where: { key } })).toBeNull();
      expect(await prisma.asset.findUnique({ where: { key: replacement } })).not.toBeNull();
      expect(await prisma.storageDeletion.findFirst({ where: { key } })).toMatchObject({ kind: "OBJECT", state: "PENDING", reason: "UNATTACHED", organisationId });
      // Repeating the request never loses or duplicates its durable row.
      await remove([key]);
      expect(await prisma.storageDeletion.count({ where: { key } })).toBe(1);
      const now = new Date();
      expect((await processStorageDeletions(now)).failed).toBe(1);
      expect(await prisma.storageDeletion.findFirst({ where: { key } })).toMatchObject({ state: "CLAIMED", lastErrorCode: "AccessDenied" });
      fake.s3!.bucket.failListWith = null;
      const retry = later(now, HOUR);
      await processStorageDeletions(retry);
      expect(fake.s3!.keys()).toEqual([replacement]);
      expect(await prisma.storageDeletion.findFirst({ where: { key } })).toMatchObject({ state: "VERIFYING" });
      await processStorageDeletions(later(retry, VERIFY_AFTER_MS + HOUR));
      expect(await prisma.storageDeletion.findFirst({ where: { key } })).toBeNull();
    } finally {
      await prisma.organisation.delete({ where: { id: organisationId } });
    }
  });

  it("removes every version and delete marker of a deleted organisation, including keys only a marker holds", async () => {
    const { cover, hidden } = await deleteOrganisationWithFiles();
    expect(fake.s3!.keys()).toEqual([cover, hidden].sort());
    await runUntilDone();
    expect(fake.s3!.bucket.entries).toEqual([]);
    expect(await prisma.storageDeletion.count()).toBe(0);
  });

  it("uses plain deletes and HEAD checks on a provider without a versions API", async () => {
    fake.s3!.bucket.versioning = "unsupported";
    await deleteOrganisationWithFiles();
    await runUntilDone();
    expect(fake.s3!.bucket.entries).toEqual([]);
    expect(await prisma.storageDeletion.count()).toBe(0);
  });

  it("keeps the row and its error code when listing versions is denied", async () => {
    const { cover } = await deleteOrganisationWithFiles();
    fake.s3!.bucket.failListWith = Object.assign(new Error("Access Denied"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
    await processStorageDeletions(new Date());
    expect(await prisma.storageDeletion.findFirst({ where: { key: cover } })).toMatchObject({ state: "CLAIMED", lastErrorCode: "AccessDenied" });
    expect(fake.s3!.keys()).toContain(cover);
  });
});
