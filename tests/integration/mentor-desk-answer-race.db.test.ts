import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: identity.id } }) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: vi.fn() }));

import { prisma } from "@/lib/db";
import { newOrderReference } from "@/lib/payments/orders";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { updateOrderAttendee } from "@/app/actions/orders";
import { resolveParticipantForUser } from "@/lib/core/mentorDesk/access";
import { raiseHelp } from "@/lib/core/mentorDesk/help";
import { lockHelpEvent } from "@/lib/core/mentorDesk/shared";
import { addCategory, createDeskEvent } from "./helpers/mentorDesk";
import { createUser, organiserId, orgSlug, register, setUpJudgingSuite, tearDownJudgingSuite } from "./helpers/judging";
import { waitForLockWait } from "./helpers/lockWait";
import { holdNextTransaction } from "./helpers/transactionBarrier";

beforeAll(setUpJudgingSuite);
afterAll(tearDownJudgingSuite);

describe.sequential("solo help creation racing answer editors", () => {
  it.each(["organiser", "buyer"])("finishes help and the %s answer edit without a deadlock", async (editor) => {
    const event = await createDeskEvent();
    const user = await createUser(`help-${editor}`);
    const seat = await register(event, `help-${editor}`, { userId: user.id });
    await addCategory(event, { key: "general" });
    const field = await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: { key: "why", label: "Why?", type: "TEXT" } } } });
    const order = await prisma.order.create({ data: { organisationId: event.organisationId, eventId: event.id, reference: newOrderReference(), buyerEmail: user.email!, buyerName: "Participant", buyerUserId: user.id, currency: "INR", status: "CONFIRMED", totalMinor: BigInt(0), subtotalMinor: BigInt(0) } });
    await prisma.rSVP.update({ where: { id: seat.rsvpId }, data: { orderId: order.id } });
    const participant = await resolveParticipantForUser(user.id, orgSlug, event.id);
    if (!participant) throw new Error("Participant missing");
    identity.id = organiserId;
    const barrier = holdNextTransaction(true);
    const helping = raiseHelp(participant, { categoryKey: "general", summary: "Build help" });
    void helping.catch(() => {});
    let editing: ReturnType<typeof updateRsvpRegistration> | undefined;
    try {
      const pid = await barrier.entered;
      editing = editor === "organiser"
        ? updateRsvpRegistration({ organisationSlug: orgSlug, eventId: event.id, rsvpId: seat.rsvpId, answers: { why: "Updated" } })
        : updateOrderAttendee({ orderToken: order.accessToken, rsvpId: seat.rsvpId, name: "Participant", answers: { why: "Updated" } });
      void editing.catch(() => {});
      await waitForLockWait(pid);
    } finally {
      barrier.release();
      barrier.restore();
      identity.id = "";
    }
    expect(await helping).toMatchObject({ ok: true });
    expect(await editing).toEqual({ ok: true });
    expect(await prisma.helpRequest.count({ where: { rsvpId: seat.rsvpId } })).toBe(1);
    expect(await prisma.rsvpAnswer.count({ where: { rsvpId: seat.rsvpId, field: { formId: field.id }, valueText: "Updated" } })).toBe(1);
  });

  it("takes a key-share Event lock compatible with an ordinary Event update", async () => {
    const event = await createDeskEvent();
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR NO KEY UPDATE`;
      // Covered against exclusive answer editors above; key-share does not
      // conflict with non-key updates, so this request can finish here.
      await prisma.$transaction((other) => lockHelpEvent(other, event.id));
    });
  });
});
