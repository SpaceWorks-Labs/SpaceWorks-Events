import "server-only";

import { EventPrivacyType, EventStatus, RegistrationMode } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { canCreateEvent, canPublishEvents, getMembership } from "@/lib/permissions";
import { normalizedTeamSettings, updateEventSchema } from "@/lib/validators";
import { countConfirmedForCapacity, takesCapacity } from "@/lib/teamUnits";
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

const EVENT_UPDATE_REFUSALS = {
  missing: "Event not found.",
  capacity: "Capacity cannot be lower than the current confirmed attendance.",
  capacityUnits: "Capacity cannot be lower than the number of teams and solo registrants who already have a place.",
  mode: "Team registration can't be turned on or off once people have registered.",
  teamSize: "Maximum team size cannot be lower than the largest current team.",
  groupTickets: "Group tickets can't be used with team registration: each person registers for themselves. Take them off sale first.",
} as const;

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
  // The form submits whole minutes. An unchanged time keeps the stored value
  // (seconds included), so it never counts as a change; a moved start must
  // not be in the past.
  const minute = (date: Date) => Math.floor(date.getTime() / 60_000);
  const startDateTime = minute(data.startDateTime) === minute(event.startDateTime) ? event.startDateTime : data.startDateTime;
  const endDateTime = minute(data.endDateTime) === minute(event.endDateTime) ? event.endDateTime : data.endDateTime;
  if (startDateTime !== event.startDateTime && startDateTime < new Date()) {
    return {
      ok: false,
      error: "Start time must be now or in the future.",
      fieldErrors: { startDateTime: ["Start time must be now or in the future"] },
    };
  }
  if (endDateTime <= startDateTime) {
    return { ok: false, error: "End must be after start.", fieldErrors: { endDateTime: ["End must be after start"] } };
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

  const teamSettings = normalizedTeamSettings(data);
  try {
    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      const locked = await tx.event.findUnique({ where: { id: event.id }, select: { status: true, registrationMode: true } });
      if (!locked) return "missing" as const;
      if (data.capacity != null) {
        // TEAM events count units (docs/TEAMS.md); INDIVIDUAL events keep the
        // confirmed-RSVP count.
        const confirmed = await countConfirmedForCapacity(tx, event.id, locked.registrationMode);
        if (confirmed > data.capacity) return locked.registrationMode === RegistrationMode.TEAM ? ("capacityUnits" as const) : ("capacity" as const);
      }
      if (teamSettings) {
        // Crew tickets (docs/CREW.md) never join teams, so they don't block a mode switch.
        if (teamSettings.registrationMode !== locked.registrationMode && (await tx.rSVP.count({ where: { eventId: event.id, ...takesCapacity } })) > 0) {
          return "mode" as const;
        }
        if (teamSettings.registrationMode === RegistrationMode.TEAM && (await tx.ticketType.count({ where: { eventId: event.id, archivedAt: null, seatsPerTicket: { gt: 1 } } })) > 0) {
          return "groupTickets" as const;
        }
        if (teamSettings.registrationMode === RegistrationMode.TEAM && teamSettings.teamMaxSize != null) {
          const largest = await tx.rSVP.groupBy({
            by: ["teamId"],
            where: { eventId: event.id, teamId: { not: null } },
            _count: { _all: true },
            orderBy: { _count: { teamId: "desc" } },
            take: 1,
          });
          if ((largest[0]?._count._all ?? 0) > teamSettings.teamMaxSize) return "teamSize" as const;
        }
      }
      await tx.event.update({
        where: { id: event.id },
        data: {
          title: data.title,
          description,
          tags: data.tags ?? [],
          showRegistrationCount: data.showRegistrationCount ?? true,
          coverImageUrl: data.coverImageUrl || null,
          startDateTime,
          endDateTime,
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
          // The form's explicit cutoff wins over closing sign-ups from the app.
          registrationManuallyClosedAt: null,
          registrationCutoffBeforeManualClose: null,
          registrationLeadBeforeManualClose: null,
          // Omitted team settings (older forms) leave the stored ones untouched.
          ...(teamSettings ?? {}),
        },
      });
      if (data.status === EventStatus.CANCELLED && event.status !== EventStatus.CANCELLED) {
        await notifyEventCancelled(tx, { organisationId: org.id, eventId: event.id, title: data.title });
      } else if (data.status === EventStatus.PUBLISHED && event.status === EventStatus.PUBLISHED && event.endDateTime > new Date()) {
        // Guests hear when the time or place changes, not about wording edits.
        const moved = startDateTime.getTime() !== event.startDateTime.getTime() || endDateTime.getTime() !== event.endDateTime.getTime() || data.timezone !== event.timezone;
        const relocated = (data.location ?? "") !== event.location || (data.isOnline ?? false) !== event.isOnline;
        if (moved || relocated) {
          await noticeEach(tx, await peopleWithPlaces(tx, { eventId: event.id }), {
            organisationId: org.id,
            subject: noticeSubject("Updated", data.title),
            lines: [
              `The organiser changed ${moved && relocated ? "the time and place" : moved ? "the time" : "the place"} of ${data.title}.`,
              `When: ${whenLabel(startDateTime, data.timezone)}`,
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
      return { previousStatus: locked.status };
    });
    if (typeof saved === "string") return { ok: false, error: EVENT_UPDATE_REFUSALS[saved] };

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
