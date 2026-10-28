"use server";

import {
  EventPageSectionType,
  EventPermission,
  EventStatus,
} from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { sanitizeRichText } from "@/lib/richText";
import { recordAuditEvent } from "@/lib/audit";
import type { ActionResult } from "./org";
import { isOrganisationUploadUrl } from "@/lib/uploadUrl";
import { context, fail, optionalImageUrl, optionalUrl, paths, target, visibility } from "./event-website/access";
import {
  uploadEventSpeakerPhoto as uploadEventSpeakerPhotoAction,
  uploadEventSponsorLogo as uploadEventSponsorLogoAction,
} from "./event-website/uploads";
import {
  saveFaq as saveFaqAction,
  saveHighlight as saveHighlightAction,
  saveResource as saveResourceAction,
  saveSpeaker as saveSpeakerAction,
  saveSponsor as saveSponsorAction,
} from "./event-website/content";
import {
  deleteScheduleTrack as deleteScheduleTrackAction,
  reorderScheduleTracks as reorderScheduleTracksAction,
  saveScheduleTrack as saveScheduleTrackAction,
  saveSession as saveSessionAction,
  setEventSessionDelay as setEventSessionDelayAction,
} from "./event-website/schedule";
import { showCrewSection as showCrewSectionAction } from "./event-website/crewSection";

export async function uploadEventSpeakerPhoto(formData: FormData): Promise<ActionResult<{ url: string; }>> {
  return uploadEventSpeakerPhotoAction(formData);
}

/** Sponsor logos follow the same validation, private storage, and WebP re-encoding path as speaker photos. */
export async function uploadEventSponsorLogo(formData: FormData): Promise<ActionResult<{ url: string; }>> {
  return uploadEventSponsorLogoAction(formData);
}

/** Switch on the public Crew section from Guests → Crew (docs/CREW.md); needs EDIT_DETAILS. */
export async function showCrewSection(input: unknown): Promise<ActionResult> {
  return showCrewSectionAction(input);
}

export async function saveEventPage(input: unknown): Promise<ActionResult> {
  const schema = target
    .extend({
      tagline: z.string().trim().max(240).default(""),
      logoUrl: optionalImageUrl,
      accentColor: z
        .union([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.literal("")])
        .optional(),
      aboutHtml: z.string().max(50_000).default(""),
      sections: z
        .array(
          z.object({
            type: z.nativeEnum(EventPageSectionType),
            isVisible: z.boolean(),
            sortOrder: z.number().int().min(0).max(20),
          }),
        )
        // Every section type once. A form opened before CREW existed still
        // sends the other nine, which leaves the saved CREW row untouched.
        .min(Object.values(EventPageSectionType).length - 1)
        .max(Object.values(EventPageSectionType).length)
        .refine((sections) => new Set(sections.map((section) => section.type)).size === sections.length),
    })
    .strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("Invalid event page settings.");
  const c = await context(parsed.data, EventPermission.EDIT_DETAILS);
  if (!c) return fail("You do not have permission to edit this event page.");
  if (
    parsed.data.logoUrl &&
    !isOrganisationUploadUrl(parsed.data.logoUrl, c.org.id, "event-page-logos")
  )
    return fail("Choose an uploaded event page logo.");
  await prisma.$transaction(async (tx) => {
    const page = await tx.eventPage.upsert({
      where: { eventId: c.event.id },
      create: {
        eventId: c.event.id,
        // Website release follows the event's published status.
        isPublished: c.event.status === EventStatus.PUBLISHED,
        tagline: parsed.data.tagline,
        logoUrl: parsed.data.logoUrl || null,
        accentColor: parsed.data.accentColor || null,
        aboutHtml: sanitizeRichText(parsed.data.aboutHtml),
      },
      update: {
        tagline: parsed.data.tagline,
        logoUrl: parsed.data.logoUrl || null,
        accentColor: parsed.data.accentColor || null,
        aboutHtml: sanitizeRichText(parsed.data.aboutHtml),
      },
    });
    for (const section of parsed.data.sections)
      await tx.eventPageSection.upsert({
        where: { pageId_type: { pageId: page.id, type: section.type } },
        create: { pageId: page.id, ...section },
        update: { isVisible: section.isVisible, sortOrder: section.sortOrder },
      });
  });
  await recordAuditEvent({
    action: "EVENT_PAGE_UPDATED",
    actorUserId: c.session.user.id,
    organisationId: c.org.id,
    targetType: "Event",
    targetId: c.event.id,
  });
  paths(c.org.slug, c.event);
  return { ok: true };
}
export async function saveHighlight(input: unknown): Promise<ActionResult> {
  return saveHighlightAction(input);
}

export async function saveSpeaker(input: unknown): Promise<ActionResult> {
  return saveSpeakerAction(input);
}

export async function saveSponsor(input: unknown): Promise<ActionResult> {
  return saveSponsorAction(input);
}

export async function saveResource(input: unknown): Promise<ActionResult> {
  return saveResourceAction(input);
}

export async function saveFaq(input: unknown): Promise<ActionResult> {
  return saveFaqAction(input);
}

export async function saveVenue(input: unknown): Promise<ActionResult> {
  const parsed = target
    .extend({
      name: z.string().trim().min(1).max(200),
      address: z.string().trim().max(500).default(""),
      city: z.string().trim().max(120).default(""),
      country: z.string().trim().max(120).default(""),
      mapLinkUrl: optionalUrl,
      directions: z.string().trim().max(4000).default(""),
      parkingInfo: z.string().trim().max(4000).default(""),
      publicTransport: z.string().trim().max(4000).default(""),
      accessibilityInfo: z.string().trim().max(4000).default(""),
      visibility,
      rooms: z.array(z.string().trim().min(1).max(120)).max(30).default([]),
    })
    .safeParse(input);
  if (!parsed.success) return fail("Invalid venue.");
  const c = await context(parsed.data, EventPermission.EDIT_DETAILS);
  if (!c) return fail("You do not have permission to manage the venue.");
  const venueData = {
    name: parsed.data.name,
    address: parsed.data.address,
    city: parsed.data.city,
    country: parsed.data.country,
    mapLinkUrl: parsed.data.mapLinkUrl || null,
    directions: parsed.data.directions,
    parkingInfo: parsed.data.parkingInfo,
    publicTransport: parsed.data.publicTransport,
    accessibilityInfo: parsed.data.accessibilityInfo,
    visibility: parsed.data.visibility,
  };
  await prisma.$transaction(async (tx) => {
    const venue = await tx.eventVenue.upsert({
      where: { eventId: c.event.id },
      create: { eventId: c.event.id, ...venueData },
      update: venueData,
    });
    await tx.eventVenueRoom.deleteMany({
      where: { venueId: venue.id, name: { notIn: parsed.data.rooms } },
    });
    for (const [sortOrder, name] of parsed.data.rooms.entries())
      await tx.eventVenueRoom.upsert({
        where: { venueId_name: { venueId: venue.id, name } },
        create: { venueId: venue.id, name, sortOrder },
        update: { sortOrder },
      });
  });
  await recordAuditEvent({
    action: "EVENT_VENUE_UPDATED",
    actorUserId: c.session.user.id,
    organisationId: c.org.id,
    targetType: "Event",
    targetId: c.event.id,
  });
  paths(c.org.slug, c.event);
  return { ok: true };
}
export async function saveScheduleTrack(input: unknown): Promise<ActionResult> {
  return saveScheduleTrackAction(input);
}

export async function deleteScheduleTrack(input: unknown): Promise<ActionResult> {
  return deleteScheduleTrackAction(input);
}

export async function reorderScheduleTracks(input: unknown): Promise<ActionResult> {
  return reorderScheduleTracksAction(input);
}

export async function saveSession(input: unknown): Promise<ActionResult<{ conflictingSessions: Array<{ id: string; title: string; }>; }>> {
  return saveSessionAction(input);
}

export async function setEventSessionDelay(input: unknown): Promise<ActionResult> {
  return setEventSessionDelayAction(input);
}

export async function deleteWebsiteContent(
  input: unknown,
): Promise<ActionResult> {
  const parsed = target
    .extend({
      kind: z.enum([
        "highlight",
        "speaker",
        "sponsor",
        "resource",
        "faq",
        "session",
      ]),
      id: z.string().min(1),
    })
    .safeParse(input);
  if (!parsed.success) return fail("Invalid delete request.");
  const permission =
    parsed.data.kind === "session"
      ? EventPermission.PUBLISH_AND_SCHEDULE
      : EventPermission.EDIT_DETAILS;
  const c = await context(parsed.data, permission);
  if (!c) return fail("You do not have permission to delete this content.");
  const where = { id: parsed.data.id, eventId: c.event.id };
  if (parsed.data.kind === "highlight")
    await prisma.eventHighlight.deleteMany({ where });
  if (parsed.data.kind === "speaker")
    await prisma.eventSpeaker.deleteMany({ where });
  if (parsed.data.kind === "sponsor")
    await prisma.eventSponsor.deleteMany({ where });
  if (parsed.data.kind === "resource")
    await prisma.eventResource.deleteMany({ where });
  if (parsed.data.kind === "faq") await prisma.eventFaq.deleteMany({ where });
  if (parsed.data.kind === "session")
    await prisma.eventSession.deleteMany({ where });
  await recordAuditEvent({
    action: "EVENT_PAGE_CONTENT_DELETED",
    actorUserId: c.session.user.id,
    organisationId: c.org.id,
    targetType: parsed.data.kind,
    targetId: parsed.data.id,
    metadata: { kind: parsed.data.kind },
  });
  paths(c.org.slug, c.event);
  return { ok: true };
}
