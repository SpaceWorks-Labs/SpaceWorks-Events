import { randomUUID } from "node:crypto";
import { EventPermission, EventStatus, MembershipRole, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { CLASSIC_DESIGN, STARTER_DESIGNS } from "@/lib/ticketDesign/presets";
import { designedTicketAttachment, ticketDesignFor } from "@/lib/ticketDesign/resolve";
import { assignDesign, createDesign, saveDesign } from "@/lib/ticketDesign/store";
import type { DesignActor } from "@/lib/ticketDesign/access";

/*
 * docs/TICKET_DESIGNER.md: who may change library templates and event
 * designs, the database rules on where a design may be used, and which design
 * a ticket ends up with (ticket type, then event, then the organisation
 * default, then the built-in Classic).
 */

const suffix = randomUUID().replace(/-/g, "");
let organisationId = "";
let otherOrganisationId = "";
let eventId = "";
let otherEventId = "";
let ticketTypeId = "";
let ticketToken = "";
const actors: Record<"owner" | "editor" | "member", DesignActor> = {} as never;

beforeAll(async () => {
  const org = await prisma.organisation.create({ data: { name: "Designs", slug: `designs-${suffix}` } });
  const other = await prisma.organisation.create({ data: { name: "Other designs", slug: `designs-other-${suffix}` } });
  organisationId = org.id;
  otherOrganisationId = other.id;
  const make = (name: string) => prisma.user.create({ data: { email: `${name}-${suffix}@example.test`, name } });
  const [owner, editor, member] = await Promise.all([make("owner"), make("editor"), make("member")]);
  await prisma.membership.createMany({ data: [{ userId: owner.id, organisationId, role: MembershipRole.OWNER }, { userId: member.id, organisationId, role: MembershipRole.MEMBER }] });
  const eventData = (slug: string) => ({ organisationId, title: "Design night", slug, startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-01T12:00:00.000Z"), timezone: "UTC", status: EventStatus.PUBLISHED, location: "Maker Hall" });
  const event = await prisma.event.create({ data: eventData(`design-${suffix}`) });
  const otherEvent = await prisma.event.create({ data: eventData(`design-two-${suffix}`) });
  eventId = event.id;
  otherEventId = otherEvent.id;
  await prisma.eventCollaborator.create({ data: { eventId, userId: editor.id, permissions: [EventPermission.EDIT_DETAILS] } });
  const type = await prisma.ticketType.create({ data: { eventId, name: "VIP" } });
  ticketTypeId = type.id;
  const rsvp = await prisma.rSVP.create({ data: { eventId, guestEmail: `guest-${suffix}@example.test`, guestName: "Guest Person", attendeeKey: `guest:guest-${suffix}@example.test`, status: RsvpStatus.CONFIRMED, ticketTypeId } });
  ticketToken = rsvp.checkInToken;
  for (const [key, user] of [["owner", owner], ["editor", editor], ["member", member]] as const) actors[key] = { userId: user.id, organisationId, organisationSlug: org.slug };
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: { in: [organisationId, otherOrganisationId] } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `${suffix}@example.test` } } });
  await prisma.$disconnect();
});

describe.sequential("ticket designs", () => {
  it("lets owners and admins keep the library, and event editors design their event", async () => {
    expect(await createDesign(actors.editor, { name: "Library" })).toMatchObject({ ok: false });
    expect(await createDesign(actors.member, { eventId, name: "Event" })).toMatchObject({ ok: false });
    const template = await createDesign(actors.owner, { name: "House style", starter: "night" });
    expect(template.ok).toBe(true);
    const copied = await createDesign(actors.editor, { eventId, name: "Event copy", fromDesignId: template.ok ? template.data.id : "" });
    expect(copied.ok).toBe(true);
    const stored = await prisma.ticketDesign.findUniqueOrThrow({ where: { id: copied.ok ? copied.data.id : "" } });
    expect(stored).toMatchObject({ eventId, name: "Event copy" });
    expect(stored.document).toEqual(STARTER_DESIGNS.find((starter) => starter.key === "night")!.document);
    expect(await saveDesign(actors.editor, template.ok ? template.data.id : "", { document: CLASSIC_DESIGN })).toMatchObject({ ok: false, error: "Design not found." });
  });

  it("validates saved documents and keeps images inside the organisation", async () => {
    const design = await createDesign(actors.editor, { eventId, name: "Checked" });
    const id = design.ok ? design.data.id : "";
    const image = { id: "logo", kind: "image" as const, x: 2, y: 2, w: 20, h: 10, rotation: 0, opacity: 1, fit: "contain" as const, radiusMm: 0 };
    const foreign = `/api/uploads/organisations/${otherOrganisationId}/ticket-design-images/${randomUUID()}.webp`;
    expect(await saveDesign(actors.editor, id, { document: { ...CLASSIC_DESIGN, elements: [...CLASSIC_DESIGN.elements, { ...image, url: foreign }] } })).toEqual({ ok: false, error: "Use images uploaded to this organisation." });
    expect(await saveDesign(actors.editor, id, { document: { ...CLASSIC_DESIGN, elements: [] } })).toMatchObject({ ok: false, error: expect.stringContaining("exactly one") });
    const own = `/api/uploads/organisations/${organisationId}/ticket-design-images/${randomUUID()}.webp`;
    expect(await saveDesign(actors.editor, id, { document: { ...CLASSIC_DESIGN, elements: [...CLASSIC_DESIGN.elements, { ...image, url: own }] }, name: "Checked v2" })).toMatchObject({ ok: true });
  });

  it("uses a design only where it belongs, in the app and in the database", async () => {
    const library = await prisma.ticketDesign.findFirstOrThrow({ where: { organisationId, eventId: null } });
    const own = await prisma.ticketDesign.findFirstOrThrow({ where: { eventId } });
    const foreign = await prisma.ticketDesign.create({ data: { organisationId, eventId: otherEventId, name: "Other event", document: CLASSIC_DESIGN } });
    expect(await assignDesign(actors.editor, { target: "event", eventId, designId: library.id })).toMatchObject({ ok: false });
    expect(await assignDesign(actors.editor, { target: "ticketType", eventId, ticketTypeId, designId: foreign.id })).toMatchObject({ ok: false });
    expect(await assignDesign(actors.editor, { target: "default", designId: library.id })).toMatchObject({ ok: false });
    await expect(prisma.event.update({ where: { id: eventId }, data: { ticketDesignId: library.id } })).rejects.toThrow();
    await expect(prisma.ticketType.update({ where: { id: ticketTypeId }, data: { ticketDesignId: foreign.id } })).rejects.toThrow();
    await expect(prisma.organisation.update({ where: { id: organisationId }, data: { defaultTicketDesignId: own.id } })).rejects.toThrow();
    expect(await assignDesign(actors.owner, { target: "default", designId: library.id })).toEqual({ ok: true, data: undefined });
    expect(await assignDesign(actors.editor, { target: "event", eventId, designId: own.id })).toEqual({ ok: true, data: undefined });
  });

  it("picks the ticket type's design, then the event's, then the default, then Classic", async () => {
    const own = await prisma.ticketDesign.findFirstOrThrow({ where: { eventId, name: "Checked v2" } });
    await assignDesign(actors.editor, { target: "ticketType", eventId, ticketTypeId, designId: own.id });
    let ticket = await ticketDesignFor(ticketToken);
    expect(ticket).toMatchObject({ custom: true, values: { name: "Guest Person", ticket: "VIP", venue: "Maker Hall", price: "Free", organisation: "Designs" } });
    expect(ticket!.document.elements.some((element) => element.id === "logo")).toBe(true);
    await assignDesign(actors.editor, { target: "ticketType", eventId, ticketTypeId, designId: null });
    ticket = await ticketDesignFor(ticketToken);
    expect(ticket!.document).toEqual(STARTER_DESIGNS.find((starter) => starter.key === "night")!.document);
    await assignDesign(actors.editor, { target: "event", eventId, designId: null });
    const library = await prisma.ticketDesign.findFirstOrThrow({ where: { organisationId, eventId: null } });
    expect((await ticketDesignFor(ticketToken))!.document).toEqual(library.document);
    await assignDesign(actors.owner, { target: "default", designId: null });
    expect(await ticketDesignFor(ticketToken)).toMatchObject({ custom: false, document: CLASSIC_DESIGN });
    expect(await designedTicketAttachment(ticketToken)).toBeUndefined();
  });

  it("attaches the designed ticket as a PDF when there is a custom design", async () => {
    const design = await createDesign(actors.editor, { eventId, name: "Email", starter: "portrait" });
    await assignDesign(actors.editor, { target: "event", eventId, designId: design.ok ? design.data.id : null });
    const attachment = await designedTicketAttachment(ticketToken);
    expect(attachment?.filename).toBe("design-night-ticket.pdf");
    expect(attachment?.content.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
