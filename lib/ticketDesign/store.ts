import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { managedImageKey } from "@/lib/badge/imageUrl";
import { canEditEventDesigns, canManageLibrary, editableDesign, type DesignActor } from "./access";
import { CLASSIC_DESIGN, STARTER_DESIGNS } from "./presets";
import { designDocumentSchema, type DesignDocument } from "./schema";

/** Creating, saving and assigning ticket designs (docs/TICKET_DESIGNER.md). */

export type DesignResult<T = undefined> = { ok: true; data: T; } | { ok: false; error: string; };
const fail = (error: string) => ({ ok: false as const, error });
const NOT_FOUND = "Design not found.";
export const MAX_LIBRARY_DESIGNS = 50;
export const MAX_EVENT_DESIGNS = 20;

/** A document checked in full, with every image one of this organisation's own uploads. */
export function validDocument(organisationId: string, input: unknown): DesignResult<DesignDocument> {
  const parsed = designDocumentSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "This design can't be saved.");
  for (const element of parsed.data.elements) {
    if (element.kind !== "image") continue;
    const key = managedImageKey(element.url);
    if (!key?.startsWith(`organisations/${organisationId}/`)) return fail("Use images uploaded to this organisation.");
    element.url = `/api/uploads/${key}`;
  }
  return { ok: true, data: parsed.data };
}

const name = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, 80) : "");

/** A new design: from a starter, or a copy of a library template or another design the actor can open. */
export async function createDesign(actor: DesignActor, input: { eventId?: string | null; name?: unknown; starter?: string | null; fromDesignId?: string | null; }): Promise<DesignResult<{ id: string; }>> {
  const eventId = input.eventId || null;
  if (eventId) {
    const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: actor.organisationId }, select: { id: true } });
    if (!event || !(await canEditEventDesigns(actor, eventId))) return fail("You can't change this event's ticket design.");
  } else if (!(await canManageLibrary(actor))) {
    return fail("Only organisation owners and admins can change the ticket design library.");
  }
  let document: DesignDocument = STARTER_DESIGNS.find((starter) => starter.key === input.starter)?.document ?? CLASSIC_DESIGN;
  if (input.fromDesignId) {
    // Library templates can be copied into any event of the organisation.
    const source = await prisma.ticketDesign.findFirst({ where: { id: input.fromDesignId, organisationId: actor.organisationId, OR: [{ eventId: null }, ...(eventId ? [{ eventId }] : [])] }, select: { document: true } });
    const copied = source ? designDocumentSchema.safeParse(source.document) : null;
    if (!copied?.success) return fail("That template can't be copied.");
    document = copied.data;
  }
  const count = await prisma.ticketDesign.count({ where: { organisationId: actor.organisationId, eventId } });
  if (count >= (eventId ? MAX_EVENT_DESIGNS : MAX_LIBRARY_DESIGNS)) return fail(eventId ? `An event can have up to ${MAX_EVENT_DESIGNS} ticket designs.` : `The library can hold up to ${MAX_LIBRARY_DESIGNS} designs.`);
  const created = await prisma.ticketDesign.create({
    data: { organisationId: actor.organisationId, eventId, name: name(input.name) || "Ticket design", document: document as Prisma.InputJsonValue, updatedById: actor.userId },
    select: { id: true },
  });
  await recordAuditEvent({ action: "TICKET_DESIGN_CREATED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: "TicketDesign", targetId: created.id, metadata: { eventId, library: !eventId } });
  return { ok: true, data: created };
}

/** Save the canvas (autosave). Never audited per keystroke: the design's updatedAt records it. */
export async function saveDesign(actor: DesignActor, designId: string, input: { document: unknown; name?: unknown; }): Promise<DesignResult<{ updatedAt: string; }>> {
  const design = await editableDesign(actor, designId);
  if (!design) return fail(NOT_FOUND);
  const checked = validDocument(actor.organisationId, input.document);
  if (!checked.ok) return checked;
  const renamed = name(input.name);
  const saved = await prisma.ticketDesign.update({
    where: { id: design.id },
    data: { document: checked.data as Prisma.InputJsonValue, ...(renamed ? { name: renamed } : {}), updatedById: actor.userId },
    select: { updatedAt: true },
  });
  return { ok: true, data: { updatedAt: saved.updatedAt.toISOString() } };
}

export async function deleteDesign(actor: DesignActor, designId: string): Promise<DesignResult> {
  const design = await editableDesign(actor, designId);
  if (!design) return fail(NOT_FOUND);
  // Events, ticket types and the default that used it fall back (ON DELETE SET NULL).
  await prisma.ticketDesign.delete({ where: { id: design.id } });
  await recordAuditEvent({ action: "TICKET_DESIGN_DELETED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: "TicketDesign", targetId: design.id, metadata: { eventId: design.eventId } });
  return { ok: true, data: undefined };
}

/** Which design the event, one of its ticket types, or the organisation default uses (null: fall back). */
export async function assignDesign(actor: DesignActor, input: { target: "event" | "ticketType" | "default"; eventId?: string | null; ticketTypeId?: string | null; designId: string | null; }): Promise<DesignResult> {
  const designId = input.designId || null;
  if (input.target === "default") {
    if (!(await canManageLibrary(actor))) return fail("Only organisation owners and admins can choose the default ticket design.");
    if (designId && !(await prisma.ticketDesign.findFirst({ where: { id: designId, organisationId: actor.organisationId, eventId: null }, select: { id: true } }))) return fail(NOT_FOUND);
    await prisma.organisation.update({ where: { id: actor.organisationId }, data: { defaultTicketDesignId: designId } });
  } else {
    const eventId = input.eventId ?? "";
    const event = await prisma.event.findFirst({ where: { id: eventId, organisationId: actor.organisationId }, select: { id: true } });
    if (!event || !(await canEditEventDesigns(actor, event.id))) return fail("You can't change this event's ticket design.");
    if (designId && !(await prisma.ticketDesign.findFirst({ where: { id: designId, eventId: event.id }, select: { id: true } }))) return fail(NOT_FOUND);
    if (input.target === "event") {
      await prisma.event.update({ where: { id: event.id }, data: { ticketDesignId: designId } });
    } else {
      const updated = await prisma.ticketType.updateMany({ where: { id: input.ticketTypeId ?? "", eventId: event.id }, data: { ticketDesignId: designId } });
      if (updated.count !== 1) return fail("That ticket no longer exists.");
    }
  }
  await recordAuditEvent({ action: "TICKET_DESIGN_ASSIGNED", actorUserId: actor.userId, organisationId: actor.organisationId, targetType: input.target === "default" ? "Organisation" : input.target === "event" ? "Event" : "TicketType", targetId: input.target === "default" ? actor.organisationId : input.target === "event" ? input.eventId ?? "" : input.ticketTypeId ?? "", metadata: { designId } });
  return { ok: true, data: undefined };
}
