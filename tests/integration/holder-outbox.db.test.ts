import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
const send = vi.hoisted(() => ({ broadcast: vi.fn(), reminder: vi.fn(), reimbursement: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => identity.id ? { user: { id: identity.id } } : null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/email", async (original) => ({ ...await original<typeof import("@/lib/email")>(), sendEventBroadcast: send.broadcast, sendReminder: send.reminder }));
vi.mock("@/lib/email/reimbursement", () => ({ sendReimbursementAvailableEmail: send.reimbursement }));

import { prisma } from "@/lib/db";
import { enqueueEventBroadcastRecipients } from "@/lib/outbox/enqueue";
import { deliverEventBroadcast } from "@/lib/outbox/broadcast";
import { deliverOutboxBatch } from "@/lib/outbox/deliver";
import { deliverReimbursementAvailable } from "@/lib/outbox/reimbursement";
import * as due from "@/lib/outbox/due";
import { transferTicket } from "@/lib/payments/transfers";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { email, owner, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";
import { paid } from "./helpers/paidOrg";
import { holderRegistration } from "./helpers/holderRegistration";

beforeAll(() => setUpPaidAttendance("Holder mail"));
afterAll(() => tearDownPaidAttendance());

describe.sequential("queued capabilities stay with their intended holder", () => {
  it.each(["buyer", "organiser"])("drops queued broadcast, reminder and reimbursement links after a %s changes the holder", async (editor) => {
    const { event, order, seat } = await holderRegistration(`mail-${editor}`);
    const broadcast = await prisma.eventBroadcast.create({ data: { eventId: event.id, createdByUserId: owner.id, subject: "Ticket", body: "{{ticketLink}}", statuses: ["CONFIRMED"], attendance: "ANY", recipientCount: 1 } });
    const payload = { to: seat.guestEmail!, broadcastId: broadcast.id, rsvpId: seat.id };
    await enqueueEventBroadcastRecipients(prisma, [payload]);
    const reminder = await prisma.outboxMessage.create({ data: { kind: "event-reminder", availableAt: new Date(), payload: { to: seat.guestEmail!, rsvpId: seat.id } } });
    const policy = await prisma.reimbursementPolicy.create({ data: { eventId: event.id, name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", capPerPersonMinor: BigInt(100000), categories: ["TRAVEL"], notifyWhenAvailable: true } });
    const reimbursement = { to: seat.guestEmail!, policyId: policy.id, rsvpId: seat.id, organisationId: paid.organisationId };
    expect(await deliverEventBroadcast(payload, "<before@outbox.invalid>")).toBe("sent");
    expect(await deliverReimbursementAvailable(reimbursement, "<before@outbox.invalid>")).toBe("sent");
    send.broadcast.mockClear(); send.reminder.mockClear(); send.reimbursement.mockClear();
    identity.id = owner.id;
    try {
      if (editor === "buyer") await transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Replacement", email: email(`mail-new-${editor}`) });
      else expect(await updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, name: "Replacement", guestEmail: email(`mail-new-${editor}`), answers: {} })).toEqual({ ok: true });
    } finally { identity.id = ""; }
    const broadcastRow = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "event-broadcast", payload: { path: ["rsvpId"], equals: seat.id } } });
    const queued = [broadcastRow.id, reminder.id];
    const spy = vi.spyOn(due, "dueOutboxMessages").mockImplementation(() => prisma.outboxMessage.findMany({ where: { id: { in: queued }, status: "PENDING" } }));
    try { expect(await deliverOutboxBatch()).toEqual({ sent: 0, failed: 0 }); } finally { spy.mockRestore(); }
    expect(await prisma.outboxMessage.count({ where: { id: { in: queued } } })).toBe(0);
    expect(await deliverReimbursementAvailable(reimbursement, "<after@outbox.invalid>")).toBe("dropped");
    expect(send.broadcast).not.toHaveBeenCalled();
    expect(send.reminder).not.toHaveBeenCalled();
    expect(send.reimbursement).not.toHaveBeenCalled();
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    // Normalise addresses for comparison; the fresh link is delivered only to its current holder.
    expect(await deliverEventBroadcast({ ...payload, to: current.guestEmail!.toUpperCase() }, "<current@outbox.invalid>")).toBe("sent");
    expect(send.broadcast).toHaveBeenCalledWith(expect.objectContaining({ to: current.guestEmail!.toUpperCase() }));
  });
});
