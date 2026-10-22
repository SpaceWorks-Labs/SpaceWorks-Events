import "server-only";

import { EventPrivacyType, EventStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canCreateEvent, canPublishEvents, getMembership } from "@/lib/permissions";
import { updateEventSchema } from "@/lib/validators";
import type { ActionResult } from "../org";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { recordAuditEvent } from "@/lib/audit";
import { isOrganisationUploadUrl } from "@/lib/uploadUrl";
import { richTextToPlainText, sanitizeRichText } from "@/lib/richText";
import { notifyEventCancelled, peopleWithPlaces, refundCancelledEvent } from "@/lib/payments/eventCancellation";
import { noticeEach, noticeSubject, whenLabel } from "@/lib/notices";
import { getBroadcastBaseUrl } from "@/lib/eventBroadcast";
import { revalidateEventPaths, validationError } from "./shared";
import { emitWebhookEvent } from "@/lib/webhooks/emit";

export async function updateEvent(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id))
    return { ok: false, error: "Too many updates. Please try again later." };

  const parsed = updateEventSchema.safeParse(input);
  if (!parsed.success) {
    const validation = validationError(parsed.error);
    return {
      ok: false,
      ...validation,
    };
  }

  const data = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: data.organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return { ok: false, error: "You do not have permission to edit events." };
  }

  if (data.status !== EventStatus.DRAFT && !canPublishEvents(membership)) {
    return {
      ok: false,
      error: "Only owners and admins can change visibility.",
    };
  }

  const event = await prisma.event.findFirst({
    where: { id: data.eventId, organisationId: org.id },
  });
  if (!event) return { ok: false, error: "Event not found." };
  const startMinute = (date: Date) => Math.floor(date.getTime() / 60_000);
  if (
    startMinute(data.startDateTime) !== startMinute(event.startDateTime) &&
    data.startDateTime < new Date()
  ) {
    return {
      ok: false,
      error: "Start time must be now or in the future.",
      fieldErrors: { startDateTime: ["Start time must be now or in the future"] },
    };
  }
  const aboutHtml =
    data.pageAboutHtml !== undefined
      ? sanitizeRichText(data.pageAboutHtml)
      : undefined;
  const description =
    aboutHtml !== undefined
      ? richTextToPlainText(aboutHtml).slice(0, 10_000)
      : (data.description ?? event.description);
  if (aboutHtml !== undefined && !description) {
    return { ok: false, error: "About the event is required." };
  }
  if (
    data.coverImageUrl &&
    !isOrganisationUploadUrl(data.coverImageUrl, org.id, "event-covers")
  ) {
    return { ok: false, error: "Choose an uploaded cover image." };
  }
  if (
    data.pageLogoUrl &&
    !isOrganisationUploadUrl(data.pageLogoUrl, org.id, "event-page-logos")
  ) {
    return { ok: false, error: "Choose an uploaded event page logo." };
  }

  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      if (data.capacity != null) {
        const confirmed = await tx.rSVP.count({
          where: { eventId: event.id, status: "CONFIRMED" },
        });
        if (confirmed > data.capacity) return false;
      }
      const locked = await tx.event.findUnique({ where: { id: event.id }, select: { status: true } });
      await tx.event.update({
        where: { id: event.id },
        data: {
          title: data.title,
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
          status: data.status,
          privacyType: data.privacyType,
          listedPublicly: data.privacyType === EventPrivacyType.APPROVAL_REQUIRED && data.listedPublicly,
          registrationClosesAt: data.registrationClosesAt ?? null,
          registrationLeadMinutes: data.registrationLeadMinutes ?? null,
        },
      });
      if (data.status === EventStatus.CANCELLED && event.status !== EventStatus.CANCELLED) {
        await notifyEventCancelled(tx, { organisationId: org.id, eventId: event.id, title: data.title });
      } else if (data.status === EventStatus.PUBLISHED && event.status === EventStatus.PUBLISHED && event.endDateTime > new Date()) {
        // Guests hear when the time or place changes, not about wording edits.
        const moved = data.startDateTime.getTime() !== event.startDateTime.getTime() || data.endDateTime.getTime() !== event.endDateTime.getTime() || data.timezone !== event.timezone;
        const relocated = (data.location ?? "") !== event.location || (data.isOnline ?? false) !== event.isOnline;
        if (moved || relocated) {
          await noticeEach(tx, await peopleWithPlaces(tx, { eventId: event.id }), {
            organisationId: org.id,
            subject: noticeSubject("Updated", data.title),
            lines: [
              `The organiser changed ${moved && relocated ? "the time and place" : moved ? "the time" : "the place"} of ${data.title}.`,
              `When: ${whenLabel(data.startDateTime, data.timezone)}`,
              `Where: ${data.isOnline ? "Online" : (data.location?.trim() || "to be announced")}`,
              `Your registration still stands. Event page: ${getBroadcastBaseUrl()}/${org.slug}/${event.slug}`,
            ],
          });
        }
      }
      await tx.eventPage.upsert({
        where: { eventId: event.id },
        create: {
          eventId: event.id,
          isPublished: data.status === EventStatus.PUBLISHED,
          tagline: data.pageTagline ?? "",
          logoUrl: data.pageLogoUrl || null,
          aboutHtml: aboutHtml ?? "",
        },
        update: {
          isPublished: data.status === EventStatus.PUBLISHED,
          ...(data.pageTagline !== undefined
            ? { tagline: data.pageTagline }
            : {}),
          ...(data.pageLogoUrl !== undefined
            ? { logoUrl: data.pageLogoUrl || null }
            : {}),
          ...(data.pageAboutHtml !== undefined
            ? { aboutHtml }
            : {}),
        },
      });
      return { previousStatus: locked?.status ?? event.status };
    });
    if (!saved)
      return {
        ok: false,
        error:
          "Capacity cannot be lower than the current confirmed attendance.",
      };

    await recordAuditEvent({
      action: "EVENT_UPDATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "Event",
      targetId: event.id,
      metadata: { status: data.status },
    });

    // Cancelling an event refunds everyone who paid, in full.
    if (data.status === EventStatus.CANCELLED && event.status !== EventStatus.CANCELLED) {
      await refundCancelledEvent({ eventId: event.id, organisationId: org.id, actorUserId: session.user.id });
    }

    if (data.status !== saved.previousStatus && (data.status === EventStatus.PUBLISHED || data.status === EventStatus.CANCELLED)) {
      emitWebhookEvent({ type: data.status === EventStatus.PUBLISHED ? "event.published" : "event.cancelled", eventId: event.id, previousStatus: saved.previousStatus });
    }
    revalidateEventPaths(org.slug, event.slug, event.id);
    return { ok: true };
  } catch {
    console.error("[event] update failed");
    return { ok: false, error: "Could not update event." };
  }
}
