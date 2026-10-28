import "server-only";

import { EventPermission } from "@prisma/client";
import { prisma } from "@/lib/db";
import { canAccessEvent } from "@/lib/eventAccess";
import { getMembership, isOrgAdmin } from "@/lib/permissions";

/**
 * Who may change ticket designs (docs/TICKET_DESIGNER.md): the organisation's
 * library templates and its default belong to owners and admins; an event's
 * own designs to anyone with EDIT_DETAILS on that event (like ticket prices).
 * Every check is staff-MFA aware through getMembership / canAccessEvent.
 */

export type DesignActor = { userId: string; organisationId: string; organisationSlug: string; };

export async function resolveDesignActor(userId: string, organisationSlug: string): Promise<DesignActor | null> {
  const organisation = await prisma.organisation.findUnique({ where: { slug: organisationSlug }, select: { id: true, slug: true } });
  return organisation ? { userId, organisationId: organisation.id, organisationSlug: organisation.slug } : null;
}

export async function canManageLibrary(actor: DesignActor) {
  const membership = await getMembership(actor.userId, actor.organisationId);
  return Boolean(membership && isOrgAdmin(membership.role));
}

export function canEditEventDesigns(actor: DesignActor, eventId: string) {
  return canAccessEvent({ userId: actor.userId, organisationId: actor.organisationId, eventId, permission: EventPermission.EDIT_DETAILS });
}

/** A design the actor may edit: a library template for owners and admins, an event's design for its editors. */
export async function editableDesign(actor: DesignActor, designId: string) {
  if (!designId || designId.length > 128) return null;
  const design = await prisma.ticketDesign.findFirst({ where: { id: designId, organisationId: actor.organisationId }, select: { id: true, eventId: true, name: true, document: true, updatedAt: true } });
  if (!design) return null;
  const allowed = design.eventId ? await canEditEventDesigns(actor, design.eventId) : await canManageLibrary(actor);
  return allowed ? design : null;
}

/** What the event Settings "Ticket design" card shows: the event's designs, which one each ticket type uses, and the library to start from. */
export async function loadEventTicketDesigns(eventId: string, organisationId: string) {
  const [event, designs, library, types] = await Promise.all([
    prisma.event.findUnique({ where: { id: eventId }, select: { ticketDesignId: true, organisation: { select: { defaultTicketDesign: { select: { id: true, name: true } } } } } }),
    prisma.ticketDesign.findMany({ where: { eventId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true, name: true } }),
    prisma.ticketDesign.findMany({ where: { organisationId, eventId: null }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, name: true } }),
    prisma.ticketType.findMany({ where: { eventId, archivedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, ticketDesignId: true } }),
  ]);
  return {
    eventDesignId: event?.ticketDesignId ?? null,
    fallbackName: event?.organisation.defaultTicketDesign ? `Organisation default (${event.organisation.defaultTicketDesign.name})` : "Built-in Classic design",
    designs,
    library,
    ticketTypes: types.map((type) => ({ id: type.id, name: type.name, designId: type.ticketDesignId })),
  };
}
