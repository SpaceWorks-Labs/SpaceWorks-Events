import { RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * A registration that changes hands (docs/PAYMENTS.md "Transfers", and an
 * organiser changing a guest's email) retires every link the previous holder
 * was given: the attendance question, the solo submission link and the
 * ticket link. A transfer racing a check-in never moves a used ticket, and a
 * "No" answered before a transfer never releases the transferred place.
 */

const identity = vi.hoisted(() => ({ id: "" }));
const hooks = vi.hoisted(() => ({ beforeCancel: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: vi.fn() }));
// The release of a "No" runs after its reply commits; a transfer can land in between.
vi.mock("@/lib/payments/operations/refund", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payments/operations/refund")>();
  return {
    ...actual,
    cancelOrderAsBuyer: async (params: Parameters<typeof actual.cancelOrderAsBuyer>[0]) => {
      await hooks.beforeCancel?.();
      return actual.cancelOrderAsBuyer(params);
    },
  };
});

import { prisma } from "@/lib/db";
import { ANSWER_CHANGED } from "@/lib/attendanceGuard";
import { respondToAttendanceCheck, sendAttendanceChecksForUser } from "@/lib/core/attendanceCheck";
import { resolveEntrantBySubmissionLink } from "@/lib/core/judging/entrantAuth";
import { transferTicket } from "@/lib/payments/transfers";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { generateSubmissionLinkToken } from "@/lib/submissionToken";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { askAndToken, buyPaid, email, owner, paidEvent, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";
import { paid } from "./helpers/paidOrg";
import { waitForLockWait, whileLocked } from "./helpers/lockWait";
import { holdNextTransaction } from "./helpers/transactionBarrier";
import { cancelRegistrationByToken } from "@/lib/rsvpCancel";

beforeAll(() => setUpPaidAttendance("Holder change"));
afterAll(() => tearDownPaidAttendance());

const allowTransfers = (eventId: string) => prisma.event.update({ where: { id: eventId }, data: { allowTransfers: true, transferCutoffHours: 1 } });

/** A free ticket order: confirmed at once, with its order link. */
async function freeOrder(label: string) {
  const { event } = await paidEvent({ kind: "NONE" });
  await allowTransfers(event.id);
  const free = await prisma.ticketType.create({ data: { eventId: event.id, name: "Free", priceMinor: BigInt(0) } });
  const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email(label), name: "First Holder", answers: {}, items: [{ ticketTypeId: free.id, quantity: 1 }] }, { userId: null });
  expect(result).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED } });
  const order = await prisma.order.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvps: true } });
  return { event, order, seat: order.rsvps[0]! };
}

async function submissionLink(rsvpId: string) {
  const link = generateSubmissionLinkToken();
  await prisma.submissionLink.create({ data: { rsvpId, tokenHash: link.hash } });
  expect(await resolveEntrantBySubmissionLink(link.raw)).not.toBeNull();
  return link.raw;
}

const answer = (token: string, response: "ATTENDING" | "NOT_ATTENDING") => respondToAttendanceCheck({ token, response, note: "" });
const NO_LONGER_VALID = { ok: false, error: "This link is no longer valid." };

describe.sequential("a registration changing hands", () => {
  it.each(["organiser", "buyer"])("refuses an old ticket cancellation waiting behind a %s holder change", async (editor) => {
    const { event, order, seat } = await freeOrder(`cancel-${editor}`);
    // Exercise both a standalone free registration and a free ticket on an order.
    if (editor === "organiser") await prisma.rSVP.update({ where: { id: seat.id }, data: { orderId: null, ticketTypeId: null } });
    identity.id = owner.id;
    const barrier = holdNextTransaction();
    const changing = editor === "buyer"
      ? transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Replacement Holder", email: email(`replacement-${editor}`) })
      : updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: seat.id, name: "Replacement Holder", guestEmail: email(`replacement-${editor}`), answers: {} });
    let cancelling: ReturnType<typeof cancelRegistrationByToken> | undefined;
    try {
      const pid = await barrier.entered;
      cancelling = cancelRegistrationByToken(null, seat.checkInToken);
      await waitForLockWait(pid);
    } finally {
      barrier.release();
      await changing;
      barrier.restore();
      identity.id = "";
    }
    expect(await cancelling).toEqual({ ok: false, error: "RSVP not found." });
    const after = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect(after).toMatchObject({ status: "CONFIRMED", guestEmail: email(`replacement-${editor}`) });
    expect(after.checkInToken === seat.checkInToken).toBe(false);
  });

  it("rechecks account ownership under the RSVP lock even if the capability is unchanged", async () => {
    const { event, seat } = await freeOrder("owner-check");
    const old = await prisma.user.create({ data: { email: email("previous-account") } });
    const next = await prisma.user.create({ data: { email: email("next-account") } });
    await prisma.rSVP.update({ where: { id: seat.id }, data: { userId: old.id, attendeeKey: `user:${old.id}` } });
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      await tx.rSVP.update({ where: { id: seat.id }, data: { userId: next.id, attendeeKey: `user:${next.id}` } });
    }, () => cancelRegistrationByToken(old.id, seat.checkInToken));
    expect(result).toMatchObject({ ok: false });
    expect(await prisma.rSVP.count({ where: { id: seat.id, userId: next.id } })).toBe(1);
  });

  it("never transfers a ticket checked in while the transfer waited for it", async () => {
    const { order, seat } = await freeOrder("race-buyer");
    // The check-in holds the registration's row lock; the transfer reads it only once that commits.
    const outcome = await whileLocked(
      (tx) => tx.rSVP.update({ where: { id: seat.id }, data: { checkedInAt: new Date() } }),
      () => transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Late Friend", email: email("race-friend") }).then(() => "moved", (error: Error) => error.message),
    );
    expect(outcome).toBe("This ticket has already been used to check in, so it can't be transferred.");
    const after = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect(after).toMatchObject({ guestEmail: email("race-buyer"), checkInToken: seat.checkInToken });
    expect(after.checkedInAt).not.toBeNull();
  });

  it("retires the old holder's attendance and submission links on transfer; the new holder is asked afresh", async () => {
    const { event, order, seat } = await freeOrder("links-buyer");
    const attendance = await askAndToken(event, seat.id);
    const submit = await submissionLink(seat.id);
    expect(await transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "New Holder", email: email("links-new") })).toEqual({ moved: 1 });

    expect(await answer(attendance, "NOT_ATTENDING")).toEqual(NO_LONGER_VALID);
    expect(await resolveEntrantBySubmissionLink(submit)).toBeNull();
    const after = await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } });
    expect(after).toMatchObject({ status: RsvpStatus.CONFIRMED, guestEmail: email("links-new") });
    expect(after.checkInToken).not.toBe(seat.checkInToken);
    // The next send asks the new holder, with a new link.
    expect(await sendAttendanceChecksForUser(owner.id, { organisationSlug: paid.orgSlug, eventId: event.id })).toEqual({ ok: true, data: { queued: 1 } });
    expect(await prisma.outboxMessage.count({ where: { kind: "attendance-check", AND: [{ payload: { path: ["rsvpId"], equals: seat.id } }, { payload: { path: ["to"], equals: email("links-new") } }] } })).toBe(1);
  });

  it("keeps a transferred paid place that a No answered before the transfer would have released", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 1 });
    await allowTransfers(event.id);
    const order = await buyPaid(event, ticket.id, "inflight-buyer");
    const seat = order.rsvps[0]!;
    const token = await askAndToken(event, seat.id);
    // The No commits; the transfer lands before its release takes the locks.
    hooks.beforeCancel = async () => {
      hooks.beforeCancel = null;
      await transferTicket({ orderToken: order.accessToken, rsvpId: seat.id, name: "Bob", email: email("inflight-new") });
    };
    try {
      expect(await answer(token, "NOT_ATTENDING")).toMatchObject({ ok: true, data: { response: "NOT_ATTENDING", released: false, releaseFailed: ANSWER_CHANGED } });
    } finally {
      hooks.beforeCancel = null;
    }
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "CONFIRMED" });
    expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: seat.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED, guestEmail: email("inflight-new") });
    expect(await prisma.paymentRefund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
    expect(await prisma.attendanceCheck.count({ where: { rsvpId: seat.id } })).toBe(0);
  });

  it("retires the old holder's links when an organiser changes the guest's email, and only then", async () => {
    const { event } = await paidEvent({ kind: "NONE" });
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: email("org-old"), guestName: "Old Holder", attendeeKey: `guest:${email("org-old")}`, status: RsvpStatus.CONFIRMED } });
    const attendance = await askAndToken(event, rsvp.id);
    const submit = await submissionLink(rsvp.id);
    const edit = (fields: { name: string; guestEmail?: string; }) => updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: rsvp.id, answers: {}, ...fields });
    identity.id = owner.id;
    try {
      // A new name for the same person keeps every link.
      expect(await edit({ name: "Old Holder Renamed" })).toEqual({ ok: true });
      expect(await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } })).toMatchObject({ checkInToken: rsvp.checkInToken, guestName: "Old Holder Renamed" });
      expect(await resolveEntrantBySubmissionLink(submit)).not.toBeNull();
      expect(await prisma.attendanceCheck.count({ where: { rsvpId: rsvp.id } })).toBe(1);

      expect(await edit({ name: "New Holder", guestEmail: email("org-new") })).toEqual({ ok: true });
    } finally {
      identity.id = "";
    }
    expect(await answer(attendance, "NOT_ATTENDING")).toEqual(NO_LONGER_VALID);
    expect(await resolveEntrantBySubmissionLink(submit)).toBeNull();
    const after = await prisma.rSVP.findUniqueOrThrow({ where: { id: rsvp.id } });
    expect(after).toMatchObject({ status: RsvpStatus.CONFIRMED, guestEmail: email("org-new"), attendeeKey: `guest:${email("org-new")}` });
    expect(after.checkInToken).not.toBe(rsvp.checkInToken);
    expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-confirmation", AND: [{ payload: { path: ["to"], equals: email("org-new") } }, { payload: { path: ["checkInToken"], equals: after.checkInToken } }] } })).toBe(1);
  });
});
