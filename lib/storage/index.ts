import "server-only";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { prisma } from "@/lib/db";
import { client, storageConfigured } from "./objects";
import { uploadObject } from "./uploads";
import { queueAssetDeletions } from "./deletionQueue";

export { client, storageConfigured };

export type UploadInput = {
  key: string;
  body: Buffer | Uint8Array | Blob;
  contentType?: string;
  organisationId?: string;
  userId?: string;
};

const ORGANISATION_DERIVATIVE_KEY =
  /^organisations\/([A-Za-z0-9_-]{1,128})\/(certificate-backgrounds|certificate-assets|event-covers|event-speakers|event-sponsors|event-crew|organisation-logos|event-page-logos|member-id-photos|member-id-watermarks|ticket-design-images)\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;
const USER_DERIVATIVE_KEY =
  /^users\/([A-Za-z0-9_-]{1,128})\/profile-images\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/i;

export function isPublicDerivativeKey(key: string) {
  return ORGANISATION_DERIVATIVE_KEY.test(key) || USER_DERIVATIVE_KEY.test(key);
}

async function bytes(input: UploadInput["body"]) {
  return input instanceof Blob
    ? Buffer.from(await input.arrayBuffer())
    : Buffer.from(input);
}

export async function uploadFile(input: UploadInput): Promise<{ key: string }> {
  const organisationKeyMatch = ORGANISATION_DERIVATIVE_KEY.exec(input.key);
  const userKeyMatch = USER_DERIVATIVE_KEY.exec(input.key);
  const validOwner =
    (organisationKeyMatch &&
      input.organisationId === organisationKeyMatch[1]) ||
    (userKeyMatch && input.userId === userKeyMatch[1]);
  if (!validOwner || input.contentType !== "image/webp") {
    throw new Error("Invalid public derivative storage metadata.");
  }
  const uploadBody = await bytes(input.body);
  if (storageConfigured()) {
    // Tracked from before the PUT until the Asset exists (lib/storage/uploads.ts).
    await uploadObject({
      key: input.key,
      organisationId: input.organisationId || null,
      body: uploadBody,
      contentType: input.contentType,
      cacheControl: "public, max-age=31536000, immutable",
    });
    return { key: input.key };
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("Private object storage is not configured.");
  await prisma.asset.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      contentType: input.contentType || "application/octet-stream",
      byteSize: BigInt(uploadBody.length),
      provider: "database",
      fileData: new Uint8Array(uploadBody),
      organisationId: input.organisationId || null,
    },
    update: {
      contentType: input.contentType || "application/octet-stream",
      byteSize: BigInt(uploadBody.length),
      provider: "database",
      fileData: new Uint8Array(uploadBody),
      organisationId: input.organisationId || null,
    },
  });
  return { key: input.key };
}

export async function downloadFile(key: string) {
  if (!isPublicDerivativeKey(key)) return null;
  const asset = await prisma.asset.findUnique({
    where: { key },
    select: { provider: true, fileData: true, contentType: true },
  });
  if (!asset || asset.contentType !== "image/webp") return null;
  if (asset.provider === "s3") {
    if (!storageConfigured())
      throw new Error("Private object storage is not configured.");
    const object = await client().send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }),
    );
    if (!object.Body) return null;
    return {
      body: await object.Body.transformToByteArray(),
      contentType:
        object.ContentType || asset.contentType || "application/octet-stream",
    };
  }
  return asset.fileData
    ? {
        body: asset.fileData,
        contentType: asset.contentType || "application/octet-stream",
      }
    : null;
}

/**
 * Remove stored derivatives (Asset row and queued object deletion). Keys that aren't
 * application derivatives are ignored. Callers treat this as best effort:
 * the database row that referenced the file is already gone.
 */
export async function deleteFiles(keys: string[]) {
  const valid = [...new Set(keys.filter(isPublicDerivativeKey))];
  if (valid.length === 0) return;
  await queueAssetDeletions(valid);
}

export function getPublicUrl(key: string): string {
  if (!isPublicDerivativeKey(key))
    throw new Error("Invalid public derivative key.");
  const base = (process.env.NEXT_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/api/uploads/${key.replace(/^\//, "")}`;
}
