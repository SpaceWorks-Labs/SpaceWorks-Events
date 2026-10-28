import { beforeEach, describe, expect, it, vi } from "vitest";
import { RsvpStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({ rsvpFind: vi.fn(), send: vi.fn(), attachment: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { rSVP: { findUnique: mocks.rsvpFind } } }));
vi.mock("@/lib/email/crew", () => ({ sendCrewTicketEmail: mocks.send }));
vi.mock("@/lib/ticketDesign/resolve", () => ({ designedTicketAttachment: mocks.attachment }));

import { asCrewTicketPayload, CREW_TICKET_KIND, deliverCrewMessage, enqueueCrewTicket, isCrewMessageKind } from "@/lib/outbox/crew";
import { containsCapability } from "@/lib/outbox/payloads";
import { BULK_OUTBOX_KINDS } from "@/lib/outbox/due";

const payload = { to: "crew@example.test", checkInToken: "ticket-secret-token", organisationId: "org_1" };
const event = { organisationId: "org_1", title: "Launch", status: "PUBLISHED", startDateTime: new Date("2030-01-01T10:00:00Z"), endDateTime: new Date("2030-01-01T12:00:00Z"), timezone: "UTC", location: "Hall A", isOnline: false };

describe("crew ticket outbox kind", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a transactional capability kind: never bulk, deleted after delivery", () => {
    expect(isCrewMessageKind(CREW_TICKET_KIND)).toBe(true);
    expect(BULK_OUTBOX_KINDS).not.toContain(CREW_TICKET_KIND);
    expect(containsCapability(CREW_TICKET_KIND, payload)).toBe(true);
  });

  it("validates the payload strictly", () => {
    expect(asCrewTicketPayload(payload)).toEqual(payload);
    expect(asCrewTicketPayload({ ...payload, to: "not an email" })).toBeNull();
    expect(asCrewTicketPayload({ ...payload, checkInToken: "x".repeat(200) })).toBeNull();
    expect(asCrewTicketPayload({ to: payload.to, checkInToken: payload.checkInToken })).toBeNull();
    expect(asCrewTicketPayload(null)).toBeNull();
  });

  it("queues the ticket in the caller's transaction", async () => {
    await enqueueCrewTicket({ outboxMessage: { create: mocks.create } } as never, payload);
    expect(mocks.create).toHaveBeenCalledWith({ data: { kind: "crew-ticket", payload } });
  });

  it("sends the crew ticket, read from the row at send time, with the designed ticket", async () => {
    mocks.rsvpFind.mockResolvedValue({ status: RsvpStatus.CONFIRMED, isCrew: true, crewMember: { name: "Asha", role: "Stage" }, event });
    mocks.attachment.mockResolvedValue({ filename: "launch-ticket.pdf", content: Buffer.from("pdf") });
    await expect(deliverCrewMessage(payload, "<m@outbox.invalid>")).resolves.toBe("sent");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: payload.to, eventTitle: "Launch", recipientName: "Asha", role: "Stage", checkInToken: payload.checkInToken, ticketPdf: expect.objectContaining({ filename: "launch-ticket.pdf" }) }));
  });

  it("drops a ticket that is no longer a confirmed crew ticket of a live event in that organisation", async () => {
    for (const row of [
      null,
      { status: RsvpStatus.CONFIRMED, isCrew: false, crewMember: null, event },
      { status: RsvpStatus.CONFIRMED, isCrew: true, crewMember: null, event },
      { status: RsvpStatus.CONFIRMED, isCrew: true, crewMember: { name: "A", role: "" }, event: { ...event, status: "CANCELLED" } },
      { status: RsvpStatus.CONFIRMED, isCrew: true, crewMember: { name: "A", role: "" }, event: { ...event, organisationId: "org_other" } },
    ]) {
      mocks.rsvpFind.mockResolvedValue(row);
      await expect(deliverCrewMessage(payload, "<m@outbox.invalid>")).resolves.toBe("dropped");
    }
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(deliverCrewMessage({ to: "bad" }, "<m@outbox.invalid>")).resolves.toBeNull();
  });
});
