import "server-only";

import { BROADCAST_PLACEHOLDERS, BROADCAST_STARTER_TEMPLATES } from "@/lib/broadcastTemplate";
import { prisma } from "@/lib/db";
import { effectiveEventProgram } from "@/lib/eventProgram";
import { BROADCAST_DESIGNS, DEFAULT_BROADCAST_DESIGN, isBroadcastDesign } from "@/lib/email/broadcastDesigns";
import { absoluteUrl } from "@/lib/mobile/dto";
import type { MobileEventContext } from "@/lib/mobile/organiser";
import { broadcastsMetaDtoSchema, scheduleDtoSchema } from "@/lib/mobile/schemas";

/* Organiser reads for the mobile apps: the emails tab's metadata and the live programme. */

export async function loadBroadcastsMeta(ctx: MobileEventContext) {
  const history = await prisma.eventBroadcast.findMany({
    where: { eventId: ctx.event.id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, subject: true, body: true, design: true, statuses: true, attendance: true, recipientCount: true, createdAt: true },
  });
  return broadcastsMetaDtoSchema.parse({
    templates: BROADCAST_STARTER_TEMPLATES.map((template) => ({
      id: template.id,
      group: template.group,
      name: template.name,
      description: template.description,
      subject: template.subject,
      bodyHtml: template.bodyHtml,
      audience: { statuses: [...template.audience.statuses], attendance: template.audience.attendance },
    })),
    designs: BROADCAST_DESIGNS.map((design) => ({ id: design.id, label: design.name, description: design.description })),
    placeholders: BROADCAST_PLACEHOLDERS.map((placeholder) => placeholder.token),
    history: history.map((row) => ({
      id: row.id,
      subject: row.subject,
      design: isBroadcastDesign(row.design) ? row.design : DEFAULT_BROADCAST_DESIGN,
      audience: { statuses: row.statuses, attendance: row.attendance },
      recipientCount: row.recipientCount,
      sentAt: row.createdAt.toISOString(),
      bodyHtml: row.body,
    })),
  });
}

/** The organiser programme: every session (any visibility) with its stored live delay, grouped by track. */
export async function loadOrganiserSchedule(ctx: MobileEventContext, baseUrl: string) {
  const [tracks, sessions] = await Promise.all([
    prisma.eventScheduleTrack.findMany({ where: { eventId: ctx.event.id }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true } }),
    prisma.eventSession.findMany({
      where: { eventId: ctx.event.id },
      orderBy: [{ startDateTime: "asc" }, { sortOrder: "asc" }],
      select: {
        id: true, title: true, type: true, visibility: true, startDateTime: true, endDateTime: true, sortOrder: true, delayMinutes: true, trackId: true,
        // Every linked speaker whatever their visibility: organisers plan with drafts too.
        speakers: {
          orderBy: { sortOrder: "asc" },
          select: { speaker: { select: { id: true, name: true, headline: true, organisation: true, photoUrl: true } } },
        },
      },
    }),
  ]);
  const program = effectiveEventProgram(sessions);
  return scheduleDtoSchema.parse({
    generatedAt: new Date().toISOString(),
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      sessions: program.filter((session) => session.trackId === track.id).map((session) => ({
        id: session.id,
        title: session.title,
        type: session.type,
        visibility: session.visibility,
        startDateTime: session.startDateTime.toISOString(),
        endDateTime: session.endDateTime.toISOString(),
        delayMinutes: session.delayMinutes,
        effectiveStartDateTime: session.effectiveStartDateTime.toISOString(),
        effectiveEndDateTime: session.effectiveEndDateTime.toISOString(),
        speakers: session.speakers.map(({ speaker }) => ({
          id: speaker.id,
          name: speaker.name,
          headline: speaker.headline || null,
          organisation: speaker.organisation || null,
          photoUrl: absoluteUrl(speaker.photoUrl, baseUrl),
        })),
      })),
    })),
  });
}
