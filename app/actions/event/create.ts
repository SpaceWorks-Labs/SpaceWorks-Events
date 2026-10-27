import "server-only";

import { EventPrivacyType, EventStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  canCreateEvent,
  canPublishEvents,
  getMembership,
  isUserEmailVerified,
} from "@/lib/permissions";
import { isReservedEventSlug, slugifyTitle, withSlugSuffix } from "@/lib/slug";
import { cloneEventSchema, createEventSchema, normalizedTeamSettings } from "@/lib/validators";
import type { ActionResult } from "../org";
import { flattenZodErrors } from "../utils";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { isOrganisationUploadUrl } from "@/lib/uploadUrl";
import { richTextToPlainText, sanitizeRichText } from "@/lib/richText";
import { revalidateEventPaths, validationError } from "./shared";
import { emitWebhookEvent } from "@/lib/webhooks/emit";

export async function createEvent(
  input: unknown,
): Promise<ActionResult<{ id: string; slug: string; }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (!(await isUserEmailVerified(session.user.id))) {
    return { ok: false, error: "Verify your email before creating events." };
  }
  if (await isActionRateLimited("create", session.user.id)) {
    return {
      ok: false,
      error: "Too many creation attempts. Please try again later.",
    };
  }

  const parsed = createEventSchema.safeParse(input);
  if (!parsed.success) {
    const validation = validationError(parsed.error);
    return {
      ok: false,
      ...validation,
    };
  }

  const data = parsed.data;
  const aboutHtml = sanitizeRichText(data.aboutHtml);
  const description = richTextToPlainText(aboutHtml).slice(0, 10_000);
  if (!description) {
    return { ok: false, error: "About the event is required." };
  }
  const org = await prisma.organisation.findUnique({
    where: { slug: data.organisationSlug },
  });
  if (!org) {
    return { ok: false, error: "Organisation not found." };
  }

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return {
      ok: false,
      error: "Only owners and admins can create events.",
    };
  }
  if (
    data.coverImageUrl &&
    !isOrganisationUploadUrl(data.coverImageUrl, org.id, "event-covers")
  ) {
    return { ok: false, error: "Choose an uploaded cover image." };
  }
  if (data.status !== EventStatus.DRAFT && !canPublishEvents(membership)) {
    return {
      ok: false,
      error: "Only owners and admins can publish or hide events.",
    };
  }

  const baseSlug = slugifyTitle(data.title);
  let slug = baseSlug;
  let attempt = 0;
  while (
    isReservedEventSlug(slug) ||
    await prisma.event.findUnique({
      where: {
        organisationId_slug: { organisationId: org.id, slug },
      },
    })
  ) {
    attempt += 1;
    if (attempt > 50) {
      return { ok: false, error: "Could not generate a unique URL slug." };
    }
    slug = withSlugSuffix(baseSlug, attempt);
  }

  try {
    const created = await prisma.event.create({
      data: {
        organisationId: org.id,
        title: data.title,
        slug,
        description,
        tags: data.tags ?? [],
        showRegistrationCount: data.showRegistrationCount ?? true,
        coverImageUrl: data.coverImageUrl || null,
        startDateTime: data.startDateTime,
        endDateTime: data.endDateTime,
        timezone: data.timezone,
        location: data.location ?? "",
        mapLinkUrl: data.mapLinkUrl || null,
        isOnline: data.isOnline ?? false,
        capacity: data.capacity ?? null,
        status: data.status ?? EventStatus.DRAFT,
        privacyType: data.privacyType ?? EventPrivacyType.PUBLIC,
        registrationClosesAt: data.registrationClosesAt ?? null,
        registrationLeadMinutes: data.registrationLeadMinutes ?? null,
        ...(normalizedTeamSettings(data) ?? {}),
        page: {
          create: {
            isPublished: data.status === EventStatus.PUBLISHED,
            aboutHtml,
          },
        },
      },
    });

    await recordAuditEvent({
      action: "EVENT_CREATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: created.id,
      metadata: { status: created.status, registrationMode: created.registrationMode },
    });

    if (created.status === EventStatus.PUBLISHED || created.status === EventStatus.CANCELLED) {
      emitWebhookEvent({ type: created.status === EventStatus.PUBLISHED ? "event.published" : "event.cancelled", eventId: created.id, previousStatus: null });
    }
    revalidateEventPaths(org.slug, slug, created.id);
    return { ok: true, data: { id: created.id, slug: created.slug } };
  } catch {
    console.error("[event] creation failed");
    return { ok: false, error: "Could not create event." };
  }
}

export async function cloneEvent(
  input: unknown,
): Promise<ActionResult<{ eventId: string; }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (!(await isUserEmailVerified(session.user.id))) {
    return { ok: false, error: "Verify your email before creating events." };
  }
  if (await isActionRateLimited("create", session.user.id))
    return {
      ok: false,
      error: "Too many creation attempts. Please try again later.",
    };

  const parsed = cloneEventSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventId } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
    select: { id: true, slug: true },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return { ok: false, error: "Only owners and admins can create events." };
  }

  const source = await prisma.event.findFirst({
    where: { id: eventId, organisationId: org.id },
  });
  if (!source) return { ok: false, error: "Event not found." };

  const newTitle = `${source.title} (copy)`;
  const baseSlug = slugifyTitle(newTitle);
  let slug = baseSlug;
  let attempt = 0;
  while (
    isReservedEventSlug(slug) ||
    await prisma.event.findUnique({
      where: { organisationId_slug: { organisationId: org.id, slug } },
      select: { id: true },
    })
  ) {
    attempt += 1;
    if (attempt > 50) {
      return { ok: false, error: "Could not generate a unique URL slug." };
    }
    slug = withSlugSuffix(baseSlug, attempt);
  }

  try {
    const created = await prisma.event.create({
      data: {
        organisationId: org.id,
        title: newTitle,
        slug,
        description: source.description ?? "",
        coverImageUrl: source.coverImageUrl,
        startDateTime: source.startDateTime,
        endDateTime: source.endDateTime,
        timezone: source.timezone,
        location: source.location ?? "",
        mapLinkUrl: source.mapLinkUrl,
        isOnline: source.isOnline,
        capacity: source.capacity,
        // Clone as draft to prevent accidental double-publishing.
        status: EventStatus.DRAFT,
        privacyType: source.privacyType,
        listedPublicly: source.listedPublicly,
        registrationMode: source.registrationMode,
        teamMinSize: source.teamMinSize,
        teamMaxSize: source.teamMaxSize,
        soloPolicy: source.soloPolicy,
        // Hackathon email switches carry over (lib/hackathonEmails.ts).
        emailEntrantsOnResults: source.emailEntrantsOnResults,
        emailSubmissionReceipts: source.emailSubmissionReceipts,
        // The setting is copied; attendance checks (and their answers) never are.
        attendanceCheckReleaseOnDecline: source.attendanceCheckReleaseOnDecline,
      },
    });

    await recordAuditEvent({
      action: "EVENT_CLONED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: created.id,
      metadata: { sourceEventId: source.id },
    });

    revalidateEventPaths(org.slug, created.slug, created.id);
    return { ok: true, data: { eventId: created.id } };
  } catch {
    console.error("[event] clone failed");
    return { ok: false, error: "Could not clone event." };
  }
}
