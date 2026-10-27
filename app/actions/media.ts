"use server";

import { EventPermission } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canAccessEvent } from "@/lib/eventAccess";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { getPublicUrl, uploadFile } from "@/lib/storage";
import { recordAuditEvent } from "@/lib/audit";
import type { ActionResult } from "./org";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

async function imageFile(formData: FormData) {
  const file = formData.get("file");
  if (!(file instanceof File))
    return { error: "Choose an image to upload." } as const;
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES)
    return { error: "Images must be 5 MB or smaller." } as const;
  const derivative = await createSafeWebpDerivative(file, {
    width: 1200,
    height: 1200,
    fit: "inside",
  });
  return derivative;
}

export async function uploadOrganisationLogo(
  formData: FormData,
): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("upload", session.user.id))
    return { ok: false, error: "Too many uploads. Please try again later." };
  const slug = String(formData.get("organisationSlug") ?? "").trim();
  const org = slug
    ? await prisma.organisation.findUnique({
        where: { slug },
        select: { id: true, slug: true },
      })
    : null;
  if (!org) return { ok: false, error: "Organisation not found." };
  const membership = await getMembership(session.user.id, org.id);
  if (!membership || !isOrgAdmin(membership.role))
    return { ok: false, error: "Only organisation admins can upload logos." };
  const derivative = await imageFile(formData);
  if ("error" in derivative) return { ok: false, error: derivative.error };
  try {
    const key = `organisations/${org.id}/organisation-logos/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      organisationId: org.id,
    });
    await recordAuditEvent({
      action: "ORGANISATION_LOGO_UPLOADED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Organisation",
      targetId: org.id,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    console.error("[media] organisation logo upload failed");
    return { ok: false, error: "Could not upload the organisation logo." };
  }
}

export async function uploadEventPageLogo(
  formData: FormData,
): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("eventPageUpload", session.user.id))
    return { ok: false, error: "Too many uploads. Please try again later." };
  const organisationSlug = String(
    formData.get("organisationSlug") ?? "",
  ).trim();
  const eventId = String(formData.get("eventId") ?? "").trim();
  const org = organisationSlug
    ? await prisma.organisation.findUnique({
        where: { slug: organisationSlug },
        select: { id: true },
      })
    : null;
  if (
    !org ||
    !eventId ||
    !(await canAccessEvent({
      userId: session.user.id,
      organisationId: org.id,
      eventId,
      permission: EventPermission.EDIT_DETAILS,
    }))
  )
    return {
      ok: false,
      error: "You do not have permission to upload this logo.",
    };
  const derivative = await imageFile(formData);
  if ("error" in derivative) return { ok: false, error: derivative.error };
  try {
    const key = `organisations/${org.id}/event-page-logos/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      organisationId: org.id,
    });
    await recordAuditEvent({
      action: "EVENT_PAGE_LOGO_UPLOADED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: eventId,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    console.error("[media] event page logo upload failed");
    return { ok: false, error: "Could not upload the event page logo." };
  }
}

export async function uploadAccountProfileImage(
  formData: FormData,
): Promise<ActionResult<{ url: string }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("upload", session.user.id))
    return { ok: false, error: "Too many uploads. Please try again later." };
  const derivative = await imageFile(formData);
  if ("error" in derivative) return { ok: false, error: derivative.error };
  try {
    const key = `users/${session.user.id}/profile-images/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      userId: session.user.id,
    });
    await recordAuditEvent({
      action: "ACCOUNT_PROFILE_IMAGE_UPLOADED",
      actorUserId: session.user.id,
      targetType: "User",
      targetId: session.user.id,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    console.error("[media] account profile image upload failed");
    return { ok: false, error: "Could not upload the profile image." };
  }
}
