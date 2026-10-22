"use server";

import { EventStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  canCreateEvent,
  canPublishEvents,
  getMembership,
  isUserEmailVerified,
} from "@/lib/permissions";
import { updateEventSlugSchema } from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { getPublicUrl, uploadFile } from "@/lib/storage";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { recordAuditEvent } from "@/lib/audit";
import { z } from "zod";
import { revalidateEventPaths } from "./event/shared";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { cloneEvent as cloneEventAction, createEvent as createEventAction } from "./event/create";
import { updateEvent as updateEventAction } from "./event/update";
import { cancelEvent as cancelEventAction, deleteEvent as deleteEventAction } from "./event/remove";

const MAX_COVER_IMAGE_BYTES = 5 * 1024 * 1024;
const publishEventSchema = z
  .object({
    organisationSlug: z.string().trim().min(1).max(120),
    eventSlug: z.string().trim().min(1).max(64),
  })
  .strict();

export async function uploadEventCoverImage(
  formData: FormData,
): Promise<ActionResult<{ url: string; }>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You must be signed in." };
  if (!(await isUserEmailVerified(session.user.id)))
    return {
      ok: false,
      error: "Verify your email before uploading event images.",
    };
  if (await isActionRateLimited("upload", session.user.id)) {
    return { ok: false, error: "Too many uploads. Please try again later." };
  }

  const organisationSlug = String(
    formData.get("organisationSlug") ?? "",
  ).trim();
  const file = formData.get("file");
  if (!organisationSlug || !(file instanceof File)) {
    return { ok: false, error: "Choose an image to upload." };
  }
  if (file.size === 0 || file.size > MAX_COVER_IMAGE_BYTES) {
    return { ok: false, error: "Cover images must be 5 MB or smaller." };
  }
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };
  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return {
      ok: false,
      error: "You do not have permission to upload cover images.",
    };
  }
  try {
    const derivative = await createSafeWebpDerivative(file, {
      width: 2400,
      height: 2400,
      fit: "inside",
    });
    if ("error" in derivative) return { ok: false, error: derivative.error };
    const key = `organisations/${org.id}/event-covers/${crypto.randomUUID()}.webp`;
    await uploadFile({
      key,
      body: derivative.body,
      contentType: "image/webp",
      organisationId: org.id,
    });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    console.error("[event] cover image upload failed");
    return { ok: false, error: "Could not upload the cover image." };
  }
}

export async function createEvent(
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string; }>> {
  return createEventAction(input);
}

export async function updateEvent(input: unknown): Promise<ActionResult> {
  return updateEventAction(input);
}

export async function deleteEvent(input: unknown): Promise<ActionResult> {
  return deleteEventAction(input);
}

export async function updateEventSlug(
  input: unknown,
): Promise<ActionResult<{ slug: string; }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id))
    return { ok: false, error: "Too many updates. Please try again later." };

  const parsed = updateEventSlugSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId, slug } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
    select: { id: true, slug: true },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return { ok: false, error: "You do not have permission to edit events." };
  }

  const event = await prisma.event.findFirst({
    where: { id: eventId, organisationId: org.id },
    select: { id: true, slug: true },
  });
  if (!event) return { ok: false, error: "Event not found." };

  if (event.slug === slug) {
    return { ok: true, data: { slug } };
  }

  const exists = await prisma.event.findUnique({
    where: { organisationId_slug: { organisationId: org.id, slug } },
    select: { id: true },
  });
  if (exists) {
    return {
      ok: false,
      error: "That URL is already taken for this organisation.",
      fieldErrors: { slug: ["Already taken"] },
    };
  }

  try {
    await prisma.event.update({ where: { id: event.id }, data: { slug } });
    await recordAuditEvent({
      action: "EVENT_SLUG_UPDATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: event.id,
    });
    // Revalidate both old and new public URLs + dashboard.
    revalidateEventPaths(org.slug, event.slug, event.id);
    revalidateEventPaths(org.slug, slug, event.id);
    return { ok: true, data: { slug } };
  } catch {
    console.error("[event] deletion failed");
    return { ok: false, error: "Could not update event URL." };
  }
}

export async function cloneEvent(
  input: unknown,
): Promise<ActionResult<{ eventId: string; }>> {
  return cloneEventAction(input);
}

export async function publishEvent(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id))
    return { ok: false, error: "Too many updates. Please try again later." };
  const parsed = publishEventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid publish request." };

  const org = await prisma.organisation.findUnique({
    where: { slug: parsed.data.organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canPublishEvents(membership)) {
    return { ok: false, error: "Only owners and admins can publish." };
  }

  const event = await prisma.event.findUnique({
    where: {
      organisationId_slug: {
        organisationId: org.id,
        slug: parsed.data.eventSlug,
      },
    },
  });
  if (!event) return { ok: false, error: "Event not found." };

  // Website visibility follows the event's published status, as in the event
  // form; without the release a published event's public page stays 404.
  await prisma.$transaction([
    prisma.event.update({
      where: { id: event.id },
      data: { status: EventStatus.PUBLISHED },
    }),
    prisma.eventPage.upsert({
      where: { eventId: event.id },
      create: { eventId: event.id, isPublished: true },
      update: { isPublished: true },
    }),
  ]);

  if (event.status !== EventStatus.PUBLISHED) {
    emitWebhookEvent({ type: "event.published", eventId: event.id, previousStatus: event.status });
  }
  await recordAuditEvent({
    action: "EVENT_PUBLISHED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "Event",
    targetId: event.id,
  });

  revalidateEventPaths(org.slug, event.slug, event.id);
  return { ok: true };
}

/**
 * Cancel an event: it stops taking registrations and shows as cancelled,
 * everyone who paid is refunded in full (and emailed), and everyone with a
 * free place is told. Owners and admins only. Running it again only finishes
 * what's left, so nobody is refunded twice.
 */
export async function cancelEvent(input: unknown): Promise<ActionResult<{ refunded: number; failed: number; notified: number; }>> {
  return cancelEventAction(input);
}
