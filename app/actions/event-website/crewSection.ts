import "server-only";

import { EventPageSectionType, EventPermission, EventStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import type { ActionResult } from "../org";
import { context, fail, paths, target } from "./access";

/**
 * Switch on the public Crew section (docs/CREW.md), the same change as
 * turning it on in Event page → Sections and saving. Needs EDIT_DETAILS like
 * every page setting; a section already saved keeps its place, a new one goes last.
 */
export async function showCrewSection(input: unknown): Promise<ActionResult> {
  const parsed = target.strict().safeParse(input);
  if (!parsed.success) return fail("Invalid event page settings.");
  const c = await context(parsed.data, EventPermission.EDIT_DETAILS);
  if (!c) return fail("You do not have permission to edit this event page.");
  await prisma.$transaction(async (tx) => {
    const page = await tx.eventPage.upsert({
      where: { eventId: c.event.id },
      // Website release follows the event's published status.
      create: { eventId: c.event.id, isPublished: c.event.status === EventStatus.PUBLISHED },
      update: {},
      select: { id: true },
    });
    const last = await tx.eventPageSection.aggregate({ where: { pageId: page.id }, _max: { sortOrder: true } });
    await tx.eventPageSection.upsert({
      where: { pageId_type: { pageId: page.id, type: EventPageSectionType.CREW } },
      create: { pageId: page.id, type: EventPageSectionType.CREW, isVisible: true, sortOrder: Math.min(20, (last._max.sortOrder ?? 8) + 1) },
      update: { isVisible: true },
    });
  });
  await recordAuditEvent({ action: "EVENT_PAGE_UPDATED", actorUserId: c.session.user.id, organisationId: c.org.id, targetType: "Event", targetId: c.event.id });
  paths(c.org.slug, c.event);
  return { ok: true };
}
