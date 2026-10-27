import "server-only";

import { EventPermission } from "@prisma/client";
import { auth } from "@/lib/auth";
import { isUserEmailVerified } from "@/lib/permissions";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { getPublicUrl, uploadFile } from "@/lib/storage";
import type { ActionResult } from "../org";
import { MAX_SPEAKER_PHOTO_BYTES, context, target } from "./access";

export async function uploadEventSpeakerPhoto(
  formData: FormData,
): Promise<ActionResult<{ url: string; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (!(await isUserEmailVerified(session.user.id)))
    return {
      ok: false,
      error: "Verify your email before uploading speaker photos.",
    };
  if (await isActionRateLimited("eventPageUpload", session.user.id))
    return { ok: false, error: "Too many uploads. Please try again later." };
  const parsed = target.safeParse({
    organisationSlug: formData.get("organisationSlug"),
    eventId: formData.get("eventId"),
  });
  const file = formData.get("file");
  if (!parsed.success || !(file instanceof File))
    return { ok: false, error: "Choose a speaker photo to upload." };
  if (file.size === 0 || file.size > MAX_SPEAKER_PHOTO_BYTES)
    return { ok: false, error: "Speaker photos must be 5 MB or smaller." };
  const c = await context(parsed.data, EventPermission.EDIT_DETAILS);
  if (!c)
    return {
      ok: false,
      error: "You do not have permission to upload speaker photos.",
    };
  try {
    const derivative = await createSafeWebpDerivative(file, {
      width: 1200,
      height: 1200,
      fit: "cover",
      position: "attention",
    });
    if ("error" in derivative) return { ok: false, error: derivative.error };
    const key = `organisations/${c.org.id}/event-speakers/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      organisationId: c.org.id,
    });
    await recordAuditEvent({
      action: "EVENT_SPEAKER_PHOTO_UPLOADED",
      actorUserId: session.user.id,
      organisationId: c.org.id,
      targetType: "Event",
      targetId: c.event.id,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    return { ok: false, error: "Could not upload the speaker photo." };
  }
}

export async function uploadEventSponsorLogo(
  formData: FormData,
): Promise<ActionResult<{ url: string; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (!(await isUserEmailVerified(session.user.id)))
    return {
      ok: false,
      error: "Verify your email before uploading sponsor logos.",
    };
  if (await isActionRateLimited("eventPageUpload", session.user.id))
    return { ok: false, error: "Too many uploads. Please try again later." };
  const parsed = target.safeParse({
    organisationSlug: formData.get("organisationSlug"),
    eventId: formData.get("eventId"),
  });
  const file = formData.get("file");
  if (!parsed.success || !(file instanceof File))
    return { ok: false, error: "Choose a sponsor logo to upload." };
  if (file.size === 0 || file.size > MAX_SPEAKER_PHOTO_BYTES)
    return { ok: false, error: "Sponsor logos must be 5 MB or smaller." };
  const c = await context(parsed.data, EventPermission.EDIT_DETAILS);
  if (!c)
    return {
      ok: false,
      error: "You do not have permission to upload sponsor logos.",
    };
  try {
    const derivative = await createSafeWebpDerivative(file, {
      width: 1200,
      height: 1200,
      fit: "inside",
    });
    if ("error" in derivative) return { ok: false, error: derivative.error };
    const key = `organisations/${c.org.id}/event-sponsors/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      organisationId: c.org.id,
    });
    await recordAuditEvent({
      action: "EVENT_SPONSOR_LOGO_UPLOADED",
      actorUserId: session.user.id,
      organisationId: c.org.id,
      targetType: "Event",
      targetId: c.event.id,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    return { ok: false, error: "Could not upload the sponsor logo." };
  }
}
