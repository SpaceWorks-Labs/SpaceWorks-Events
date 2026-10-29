import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The storage deletion queue against a fake object store (docs/CONFIGURATION.md
 * "Object storage"): uploads are registered before their PUT, a claimed row
 * can never be published, deletions are verified a day later, prefix listings
 * never override an upload in progress, and rows for another bucket are kept.
 */
const store = vi.hoisted(() => ({
  objects: new Set<string>(),
  deleted: [] as string[],
  /** The next PUT fails for the caller but lands later (an uncertain write). */
  lostPuts: [] as string[],
  failNextPut: false,
  /** The next DELETE removes the objects, then the call fails (a crash after the delete). */
  failAfterDelete: false,
  pageSize: 1000,
  poison: null as string | null,
  /** The next listing is computed, then waits here until released (a worker stalled past its lease). */
  stall: null as null | { reached: () => void; release: Promise<void> },
}));

vi.mock("@/lib/storage/objects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage/objects")>()),
  putObject: vi.fn(async ({ key }: { key: string }) => {
    if (store.failNextPut) {
      store.failNextPut = false;
      store.lostPuts.push(key);
      throw new Error("socket hang up");
    }
    store.objects.add(key);
  }),
  deleteObjects: vi.fn(async (keys: string[]) => {
    for (const key of keys) store.objects.delete(key);
    store.deleted.push(...keys);
    if (store.failAfterDelete) {
      store.failAfterDelete = false;
      throw Object.assign(new Error("connection reset"), { name: "TimeoutError" });
    }
    return new Map<string, string>();
  }),
  objectRemains: vi.fn(async (key: string) => store.objects.has(key)),
  listObjectsPage: vi.fn(async (prefix: string, token: string | null) => {
    const all = [...store.objects].filter((key) => key.startsWith(prefix)).sort();
    if (store.poison?.startsWith(prefix)) all.push(store.poison);
    // Like S3, a page continues after the last key returned, whatever was deleted meanwhile.
    const rest = token ? all.filter((key) => key > token) : all;
    const keys = rest.slice(0, store.pageSize);
    const stall = store.stall;
    store.stall = null;
    if (stall) {
      stall.reached();
      await stall.release;
    }
    return { keys, next: rest.length > store.pageSize ? keys.at(-1)! : null };
  }),
}));

import { prisma } from "@/lib/db";
import { uploadFile } from "@/lib/storage";
import { currentStorageLocation } from "@/lib/storage/objects";
import { publishUpload, putRegistered, registerUpload, UPLOAD_GRACE_MS } from "@/lib/storage/uploads";
import { processStorageDeletions, purgeUnattachedReceipts, queueOrganisationStorage, storageDeletionProblems, VERIFY_AFTER_MS } from "@/lib/storage/deletionQueue";

const HOUR = 60 * 60_000;
const object = { body: Buffer.from("webp"), contentType: "image/webp", cacheControl: "private, no-store" };
const later = (from: Date, ms: number) => new Date(from.getTime() + ms);
const coverKey = (organisationId: string) => `organisations/${organisationId}/event-covers/${randomUUID()}.webp`;
const rowFor = (key: string) => prisma.storageDeletion.findFirst({ where: { key, kind: "OBJECT" } });
let organisationId = "";
let enabledAt: Date;

async function newOrganisation(label: string) {
  return (await prisma.organisation.create({ data: { name: label, slug: `storage-${label}-${randomUUID().slice(0, 8)}` } })).id;
}
const assetData = (orgId: string | null) => ({ key: "", contentType: "image/webp", byteSize: BigInt(4), provider: "s3", organisationId: orgId });

beforeAll(async () => {
  vi.stubEnv("S3_BUCKET", "queue-test");
  vi.stubEnv("S3_REGION", "auto");
  vi.stubEnv("S3_ENDPOINT", "https://storage.example.test");
  organisationId = await newOrganisation("main");
  enabledAt = (await prisma.storageProtocol.findUniqueOrThrow({ where: { id: 1 } })).enabledAt;
});

beforeEach(async () => {
  await prisma.storageDeletion.deleteMany({});
  store.objects.clear();
  store.deleted.length = 0;
  store.lostPuts.length = 0;
  store.pageSize = 1000;
  store.poison = null;
});

afterEach(() => {
  vi.stubEnv("S3_BUCKET", "queue-test");
});

afterAll(async () => {
  await prisma.storageProtocol.update({ where: { id: 1 }, data: { enabledAt } });
  await prisma.storageDeletion.deleteMany({});
  await prisma.organisation.deleteMany({ where: { name: { in: ["main", "deleted", "receipts"] } } });
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe.sequential("storage deletion queue", () => {
  it("publishes an upload and keeps no deletion row for it", async () => {
    const key = coverKey(organisationId);
    await uploadFile({ key, body: object.body, contentType: "image/webp", organisationId });
    expect(store.objects.has(key)).toBe(true);
    expect(await prisma.asset.findUnique({ where: { key } })).toMatchObject({ provider: "s3", organisationId });
    expect(await rowFor(key)).toBeNull();
    // A key already in use is refused before any byte is sent.
    await expect(registerUpload(key, organisationId)).rejects.toThrow("already in use");
  });

  it("refuses a PUT that starts after the deadline, then deletes and verifies its key", async () => {
    const now = new Date();
    const upload = await registerUpload(coverKey(organisationId), organisationId, now);
    await expect(putRegistered(upload, object, later(upload.deadline, 1))).rejects.toThrow("did not start in time");
    expect(store.objects.size).toBe(0);
    expect(await rowFor(upload.key)).toMatchObject({ state: "PENDING", reason: "UPLOAD_PENDING" });
    // Not before the deadline plus the grace period.
    await processStorageDeletions(later(upload.deadline, UPLOAD_GRACE_MS - 1));
    expect(await rowFor(upload.key)).toMatchObject({ state: "PENDING" });
    const due = later(upload.deadline, UPLOAD_GRACE_MS + 1);
    await processStorageDeletions(due);
    expect(await rowFor(upload.key)).toMatchObject({ state: "VERIFYING" });
    await processStorageDeletions(later(due, VERIFY_AFTER_MS + HOUR));
    expect(await rowFor(upload.key)).toBeNull();
  });

  it("lets a publication that comes first keep its object", async () => {
    const upload = await registerUpload(coverKey(organisationId), organisationId);
    await putRegistered(upload, object);
    await publishUpload(upload, assetData(organisationId));
    await processStorageDeletions(later(upload.deadline, 100 * HOUR));
    expect(store.objects.has(upload.key)).toBe(true);
    expect(await prisma.asset.findUnique({ where: { key: upload.key } })).not.toBeNull();
  });

  it("never publishes once the worker has claimed the row", async () => {
    const upload = await registerUpload(coverKey(organisationId), organisationId);
    await putRegistered(upload, object);
    await processStorageDeletions(later(upload.deadline, UPLOAD_GRACE_MS + 1));
    expect(store.objects.has(upload.key)).toBe(false);
    await expect(publishUpload(upload, assetData(organisationId))).rejects.toThrow("expired");
    expect(await prisma.asset.findUnique({ where: { key: upload.key } })).toBeNull();
    expect(await rowFor(upload.key)).toMatchObject({ state: "VERIFYING" });
  });

  it("repeats a delete safely after the worker failed during it", async () => {
    const upload = await registerUpload(coverKey(organisationId), organisationId);
    await putRegistered(upload, object);
    const due = later(upload.deadline, UPLOAD_GRACE_MS + 1);
    store.failAfterDelete = true;
    await processStorageDeletions(due);
    expect(await rowFor(upload.key)).toMatchObject({ state: "CLAIMED", lastErrorCode: "TimeoutError" });
    // Claimed rows never return to PENDING, so the upload still cannot publish.
    await expect(publishUpload(upload, assetData(organisationId))).rejects.toThrow("expired");
    await processStorageDeletions(later(due, HOUR));
    expect(store.deleted.filter((key) => key === upload.key)).toHaveLength(2);
    expect(await rowFor(upload.key)).toMatchObject({ state: "VERIFYING", lastErrorCode: null });
  });

  it("removes an uncertain PUT that lands after the first delete", async () => {
    const upload = await registerUpload(coverKey(organisationId), organisationId);
    store.failNextPut = true;
    await expect(putRegistered(upload, object)).rejects.toThrow();
    const due = later(upload.deadline, UPLOAD_GRACE_MS + 1);
    await processStorageDeletions(due);
    expect(await rowFor(upload.key)).toMatchObject({ state: "VERIFYING" });
    store.objects.add(store.lostPuts.pop()!); // The lost write takes effect now.
    const check = later(due, VERIFY_AFTER_MS + HOUR);
    await processStorageDeletions(check);
    expect(store.objects.has(upload.key)).toBe(false);
    expect(await rowFor(upload.key)).toMatchObject({ state: "VERIFYING", lastErrorCode: "STILL_PRESENT" });
    await processStorageDeletions(later(check, VERIFY_AFTER_MS + HOUR));
    expect(await rowFor(upload.key)).toBeNull();
  });

  it("removes every object of a deleted organisation, including an upload in progress, without overriding its row", async () => {
    await prisma.storageProtocol.update({ where: { id: 1 }, data: { enabledAt: new Date(Date.now() - 48 * HOUR) } });
    const doomed = await newOrganisation("deleted");
    const published = coverKey(doomed);
    await uploadFile({ key: published, body: object.body, contentType: "image/webp", organisationId: doomed });
    const inFlight = await registerUpload(coverKey(doomed), doomed);
    await putRegistered(inFlight, object);
    const legacy = `organisations/${doomed}/event-covers/legacy-without-asset.webp`;
    store.objects.add(legacy);
    store.pageSize = 2;
    // As app/actions/membership.ts deleteOrganisation does it.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${doomed} FOR UPDATE`;
      await queueOrganisationStorage(tx, doomed);
      await tx.organisation.delete({ where: { id: doomed } });
    });
    await expect(publishUpload(inFlight, assetData(doomed))).rejects.toThrow();
    const pending = await rowFor(inFlight.key);
    const now = new Date();
    await processStorageDeletions(now); // deletes the published object, lists the first page
    await processStorageDeletions(now); // the second page, and the legacy object it found
    await processStorageDeletions(now);
    expect(await rowFor(inFlight.key)).toEqual(pending); // deadline, state and fencing unchanged
    expect(store.objects.has(published) || store.objects.has(legacy)).toBe(false);
    expect(store.objects.has(inFlight.key)).toBe(true);
    expect(await prisma.storageDeletion.count({ where: { kind: "PREFIX" } })).toBe(0);
    await processStorageDeletions(later(inFlight.deadline, UPLOAD_GRACE_MS + 1));
    expect(store.objects.has(inFlight.key)).toBe(false);
    await processStorageDeletions(later(inFlight.deadline, UPLOAD_GRACE_MS + VERIFY_AFTER_MS + HOUR));
    expect(await prisma.storageDeletion.count({ where: { organisationId: doomed } })).toBe(0);
  });

  it("waits 27 hours after the protocol epoch before listing a prefix", async () => {
    await prisma.storageProtocol.update({ where: { id: 1 }, data: { enabledAt: new Date() } });
    const doomed = await newOrganisation("deleted");
    await prisma.$transaction(async (tx) => {
      await queueOrganisationStorage(tx, doomed);
      await tx.organisation.delete({ where: { id: doomed } });
    });
    const prefix = await prisma.storageDeletion.findFirstOrThrow({ where: { kind: "PREFIX", organisationId: doomed } });
    expect(prefix.notBefore.getTime() - Date.now()).toBeGreaterThan(26.9 * HOUR);
  });

  it("saves a listing page and its continuation token together", async () => {
    const prefix = `organisations/${randomUUID()}/`;
    await prisma.storageDeletion.create({ data: { kind: "PREFIX", location: currentStorageLocation()!, key: prefix, reason: "LEGACY_PREFIX", notBefore: new Date() } });
    for (const name of ["a", "b", "c"]) store.objects.add(`${prefix}${name}.webp`);
    store.pageSize = 2;
    await processStorageDeletions(new Date());
    expect((await prisma.storageDeletion.findFirstOrThrow({ where: { key: prefix } })).continuationToken).toBe(`${prefix}b.webp`);
    store.poison = `${prefix}z\u0000.webp`; // The next page cannot be saved.
    await processStorageDeletions(new Date());
    const stuck = await prisma.storageDeletion.findFirstOrThrow({ where: { key: prefix } });
    expect(stuck.continuationToken).toBe(`${prefix}b.webp`);
    expect(stuck.lastErrorCode).not.toBeNull();
    expect(await rowFor(`${prefix}c.webp`)).toBeNull();
    store.poison = null;
    await processStorageDeletions(later(new Date(), HOUR));
    expect(await rowFor(`${prefix}c.webp`)).not.toBeNull();
    expect(await prisma.storageDeletion.count({ where: { key: prefix } })).toBe(0);
  });

  it("ignores the completion of a worker delayed past its lease once another worker has claimed the row", async () => {
    const prefix = `organisations/${randomUUID()}/`;
    await prisma.storageDeletion.create({ data: { kind: "PREFIX", location: currentStorageLocation()!, key: prefix, reason: "LEGACY_PREFIX", notBefore: new Date() } });
    for (const name of ["a", "b", "c", "d", "e"]) store.objects.add(`${prefix}${name}.webp`);
    store.pageSize = 2;
    let reached!: () => void;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => { reached = resolve; });
    store.stall = { reached, release: new Promise<void>((resolve) => { release = resolve; }) };
    const start = new Date();
    const delayed = processStorageDeletions(start); // claims the row and lists the first page, then stalls
    await stalled;
    // The lease runs out; a second worker claims the row and gets two pages further.
    const afterLease = later(start, 11 * 60_000);
    await processStorageDeletions(afterLease);
    await processStorageDeletions(afterLease);
    const progressed = await prisma.storageDeletion.findFirstOrThrow({ where: { key: prefix } });
    expect(progressed).toMatchObject({ continuationToken: `${prefix}d.webp`, attempts: 3 });
    release();
    await delayed;
    // The stalled worker's first page would have set the token back to "b".
    expect(await prisma.storageDeletion.findFirstOrThrow({ where: { key: prefix } })).toMatchObject({ continuationToken: `${prefix}d.webp`, attempts: 3, notBefore: progressed.notBefore });
  });

  it("keeps and reports a row whose storage location is no longer configured", async () => {
    const upload = await registerUpload(coverKey(organisationId), organisationId);
    await putRegistered(upload, object);
    vi.stubEnv("S3_BUCKET", "another-bucket");
    await processStorageDeletions(later(upload.deadline, UPLOAD_GRACE_MS + 1));
    expect(store.deleted).not.toContain(upload.key);
    expect(store.objects.has(upload.key)).toBe(true);
    expect(await rowFor(upload.key)).toMatchObject({ lastErrorCode: "LOCATION_MISMATCH" });
    expect((await storageDeletionProblems()).misplaced).toBe(1);
  });

  it("removes an abandoned receipt after a day and keeps a referenced one", async () => {
    const orgId = await newOrganisation("receipts");
    const receiptKey = () => `organisations/${orgId}/claim-receipts/${randomUUID()}.webp`;
    const old = new Date(Date.now() - 2 * 24 * HOUR);
    const [abandoned, referenced, fresh] = [receiptKey(), receiptKey(), receiptKey()];
    for (const key of [abandoned, referenced]) await prisma.asset.create({ data: { ...assetData(orgId), key, createdAt: old } });
    await prisma.asset.create({ data: { ...assetData(orgId), key: fresh } });
    const event = await prisma.event.create({ data: {
      organisationId: orgId, title: "Receipts", slug: `receipts-${randomUUID().slice(0, 8)}`, timezone: "UTC",
      startDateTime: new Date("2031-01-01T10:00:00Z"), endDateTime: new Date("2031-01-01T12:00:00Z"), status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC,
    } });
    const claim = await prisma.expenseClaim.create({ data: {
      organisationId: orgId, eventId: event.id, eventTitle: event.title, kind: "CREW", payeeName: "Payee", payeeEmail: "payee@example.test",
      category: "TRAVEL", description: "Train", amountMinor: BigInt(2500), currency: "INR",
    } });
    await prisma.expenseReceipt.create({ data: { claimId: claim.id, storageKey: referenced, byteSize: 4 } });
    expect(await purgeUnattachedReceipts(new Date())).toBe(1);
    expect(await prisma.asset.findUnique({ where: { key: abandoned } })).toBeNull();
    expect(await rowFor(abandoned)).toMatchObject({ reason: "UNATTACHED", state: "PENDING" });
    for (const key of [referenced, fresh]) {
      expect(await prisma.asset.findUnique({ where: { key } })).not.toBeNull();
      expect(await rowFor(key)).toBeNull();
    }
    // Deleting the organisation queues the referenced receipt's key too.
    await prisma.$transaction(async (tx) => {
      await queueOrganisationStorage(tx, orgId);
      await tx.organisation.delete({ where: { id: orgId } });
    });
    expect(await rowFor(referenced)).toMatchObject({ reason: "ORG_DELETED" });
  });
});
