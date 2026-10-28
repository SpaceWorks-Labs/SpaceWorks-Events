"use server";

import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireOrgRole } from "@/lib/permissions";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { uploadFile } from "@/lib/storage";
import { recordAuditEvent } from "@/lib/audit";
import { certificateMergeTags, certificateTemplateSchema } from "@/lib/certificateTemplate";
import { certificateImagesAreOwned } from "@/lib/certificateAssets";
import { certificateMergeValues, renderCustomCertificate } from "@/lib/renderCertificate";
import type { ActionResult } from "./org";

const scope = z.object({ organisationSlug: z.string().trim().min(1).max(120), eventId: z.string().min(1).max(128) });
async function access(input: z.infer<typeof scope>) {
  const context = await requireOrgRole(input.organisationSlug, "ADMIN");
  if (await isActionRateLimited("upload", context.userId)) return null;
  const event = await prisma.event.findFirst({ where: { id: input.eventId, organisationId: context.organisation.id }, select: { id: true, title: true, startDateTime: true, timezone: true } });
  return event ? { ...context, event } : null;
}

/** Shared by backgrounds and image layers: validated, re-encoded WebP stored under the organisation. */
async function uploadCertificateImage(data: FormData, folder: "certificate-backgrounds" | "certificate-assets", maxSide: number): Promise<ActionResult<{ key: string }>> {
  const parsed = scope.safeParse({ organisationSlug: data.get("organisationSlug"), eventId: data.get("eventId") });
  if (!parsed.success) return { ok: false, error: "Invalid event." };
  const context = await access(parsed.data);
  if (!context) return { ok: false, error: "Upload unavailable. Check access or try again shortly." };
  const file = data.get("file");
  if (!(file instanceof File) || !file.size || file.size > 5 * 1024 * 1024) return { ok: false, error: "Choose a JPEG, PNG, or WebP up to 5 MB." };
  const image = await createSafeWebpDerivative(file, { width: maxSide, height: maxSide, fit: "inside", lossless: true });
  if ("error" in image) return { ok: false, error: image.error };
  try {
    const key = `organisations/${context.organisation.id}/${folder}/${crypto.randomUUID()}.webp`;
    await uploadFile({ key, body: image.body, contentType: "image/webp", organisationId: context.organisation.id });
    await recordAuditEvent({ action: "CERTIFICATE_BACKGROUND_UPLOADED", actorUserId: context.userId, organisationId: context.organisation.id, targetType: "Event", targetId: parsed.data.eventId, ...(folder === "certificate-assets" ? { metadata: { layer: "image" } } : {}) });
    return { ok: true, data: { key } };
  } catch {
    return { ok: false, error: "Could not upload the certificate image." };
  }
}

export async function uploadCertificateBackground(data: FormData): Promise<ActionResult<{ key: string }>> {
  return uploadCertificateImage(data, "certificate-backgrounds", 6000);
}

/** A logo, signature or seal placed on the certificate. PNG transparency is kept. */
export async function uploadCertificateAsset(data: FormData): Promise<ActionResult<{ key: string }>> {
  return uploadCertificateImage(data, "certificate-assets", 3000);
}

export async function previewCertificate(input: unknown): Promise<ActionResult<{ image: string }>> {
  const parsed = scope.extend({ template: certificateTemplateSchema, name: z.string().trim().min(1).max(200), contributor: z.boolean().optional() }).strict().safeParse(input);
  if (!parsed.success) return { ok: false, error: "Check the certificate layers and preview name." };
  const context = await access(parsed.data);
  if (!context) return { ok: false, error: "Preview unavailable. Check access or try again shortly." };
  if (!await certificateImagesAreOwned(parsed.data.template, context.organisation.id)) return { ok: false, error: "Invalid certificate image." };
  try {
    const values = certificateMergeValues({ name: parsed.data.name, eventTitle: context.event.title, eventStart: context.event.startDateTime, timeZone: context.event.timezone, organisationName: context.organisation.name, issuedAt: new Date(), ...(parsed.data.contributor ? { role: certificateMergeTags.role.sample, hours: certificateMergeTags.hours.sample } : {}) });
    const jpeg = await renderCustomCertificate(parsed.data.template, values, context.organisation.id);
    return { ok: true, data: { image: `data:image/jpeg;base64,${jpeg.toString("base64")}` } };
  } catch {
    return { ok: false, error: "Could not render the certificate. Check the images, text areas and server fonts." };
  }
}
