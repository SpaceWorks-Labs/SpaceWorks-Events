// Disposable deployment test only. Production operators use check.mjs.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { deleteSmokeObject } from "./smoke-storage.mjs";

await import("./check.mjs");
const prisma = new PrismaClient();
const plainUrl = new URL(process.env.DATABASE_URL);
plainUrl.searchParams.set("sslmode", "disable");
const plain = new PrismaClient({ datasources: { db: { url: plainUrl.toString() } } });
const s3 = new S3Client({ region: process.env.S3_REGION, endpoint: process.env.S3_ENDPOINT, forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } });
const objectKey = `deployment-smoke/${randomUUID()}`;
try {
  let rejected = false;
  try { await plain.$queryRaw`SELECT 1`; } catch { rejected = true; }
  assert.ok(rejected, "Plain-text database connections must fail");
  const anonymous = await fetch(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`);
  await anonymous.body?.cancel();
  assert.equal(anonymous.status, 403, "Anonymous bucket access must fail");
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey, Body: "disposable deployment check" }));
  const object = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: objectKey }));
  assert.equal(await object.Body.transformToString(), "disposable deployment check");
  // Roll back the row and its fallback audit events even when the test passes.
  const rollback = new Error("rollback disposable test");
  await prisma.$transaction(async (tx) => {
    const org = await tx.organisation.create({ data: { name: "Deployment smoke", slug: `smoke-${randomUUID()}` } });
    await tx.organisation.update({ where: { id: org.id }, data: { name: "Updated smoke" } });
    assert.ok(await tx.auditEvent.count({ where: { organisationId: org.id } }) > 0, "Runtime writes must retain audit triggers");
    await tx.organisation.delete({ where: { id: org.id } });
    throw rollback;
  }).catch((error) => { if (error !== rollback) throw error; });
  // Pages come from the website container in the split layout.
  const site = process.env.SWE_LAYOUT === "split" ? "http://frontend:3000" : "http://app:3000";
  for (const path of ["/", "/login", "/api/health"]) {
    const response = await fetch(`${site}${path}`, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    await response.body?.cancel();
    assert.equal(response.status, 200, `Application route ${path} must render`);
  }
  const unauthorized = await fetch("http://app:3000/api/health/db");
  await unauthorized.body?.cancel();
  assert.equal(unauthorized.status, 404, "Readiness must require authentication");
} catch {
  console.error("Disposable VPS smoke failed; connection details were suppressed.");
  process.exitCode = 1;
} finally {
  try {
    await deleteSmokeObject(s3, process.env.S3_BUCKET, objectKey);
  } catch {
    console.error("Disposable VPS smoke failed: object cleanup failed; connection details were suppressed.");
    process.exitCode = 1;
  }
  s3.destroy();
  await plain.$disconnect();
  await prisma.$disconnect();
}
if (!process.exitCode) console.log("Disposable VPS smoke passed: plain-text rejection, anonymous storage rejection, object roundtrip and cleanup, audited runtime writes, page rendering and readiness authorization.");
