import { AttendanceResponse, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * An older attendance "No" never undoes a newer "Yes" (docs/ATTENDANCE.md):
 * the release a "No" starts acts only while that exact answer is still the
 * current one, checked under the release's own locks. Free places, paid
 * cancellations and refund requests alike; a newer "No" still releases.
 */

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));
vi.mock("@/lib/outboxWorker", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/outboxWorker")>()), startOutboxWorker: vi.fn() }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: vi.fn() }));

import { prisma } from "@/lib/db";
import { ANSWER_CHANGED } from "@/lib/attendanceGuard";
import { respondToAttendanceCheck } from "@/lib/core/attendanceCheck";
import { askAndToken, buyPaid, email, paidEvent, setUpPaidAttendance, tearDownPaidAttendance } from "./helpers/attendancePaid";
import { whileLocked } from "./helpers/paymentAudit";

beforeAll(() => setUpPaidAttendance("Attendance race"));
afterAll(() => tearDownPaidAttendance());

const answer = (token: string, response: "ATTENDING" | "NOT_ATTENDING") => respondToAttendanceCheck({ token, response, note: "" });

/**
 * The "No" commits, then its release waits behind a lock while a "Yes" is
 * answered and committed; once the lock goes, the stale release runs.
 */
async function noThenYes(lock: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>, token: string) {
  return whileLocked(lock, async () => {
    const no = answer(token, "NOT_ATTENDING");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const yes = await answer(token, "ATTENDING");
    return { no: await no, yes };
  }, 500);
}

describe.sequential("a No racing a newer Yes", () => {
  it("keeps a free place, and a later No still releases it", async () => {
    const { event } = await paidEvent({ kind: "NONE" });
    const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: email("free-race"), guestName: "Free", attendeeKey: `guest:${email("free-race")}`, status: RsvpStatus.CONFIRMED } });
    const token = await askAndToken(event, rsvp.id);
    const { no, yes } = await noThenYes((tx) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`, token);
    expect(yes).toEqual({ ok: true, data: { response: "ATTENDING", released: false } });
    expect(no).toMatchObject({ ok: true, data: { released: false, releaseFailed: ANSWER_CHANGED } });
    expect(await prisma.rSVP.findUnique({ where: { id: rsvp.id } })).toMatchObject({ status: RsvpStatus.CONFIRMED });
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: rsvp.id } })).toMatchObject({ response: AttendanceResponse.ATTENDING, releaseOutcome: null });
    // No, Yes, then No again: the newest No releases.
    expect(await answer(token, "NOT_ATTENDING")).toEqual({ ok: true, data: { response: "NOT_ATTENDING", released: true } });
    expect(await prisma.rSVP.findUnique({ where: { id: rsvp.id } })).toBeNull();
  });

  it("keeps a paid order the older No would have cancelled and refunded", async () => {
    const { event, ticket } = await paidEvent({ kind: "FULL_UNTIL", hours: 1 });
    const order = await buyPaid(event, ticket.id, "paid-race");
    const token = await askAndToken(event, order.rsvps[0]!.id);
    const { no, yes } = await noThenYes((tx) => tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`, token);
    expect(yes).toMatchObject({ ok: true, data: { response: "ATTENDING" } });
    expect(no).toMatchObject({ ok: true, data: { released: false, releaseFailed: ANSWER_CHANGED } });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { rsvps: true } })).toMatchObject({ status: "CONFIRMED", rsvps: [expect.objectContaining({ id: order.rsvps[0]!.id })] });
    expect(await prisma.paymentRefund.count({ where: { payment: { orderId: order.id } } })).toBe(0);
  });

  it("opens no refund request for the older No once the policy has closed", async () => {
    const { event, ticket } = await paidEvent({ kind: "NONE" });
    const order = await buyPaid(event, ticket.id, "request-race");
    const token = await askAndToken(event, order.rsvps[0]!.id);
    const { no, yes } = await noThenYes((tx) => tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`, token);
    expect(yes).toMatchObject({ ok: true, data: { response: "ATTENDING" } });
    expect(no).toMatchObject({ ok: true, data: { released: false, releaseFailed: ANSWER_CHANGED } });
    expect(await prisma.refundRequest.count({ where: { orderId: order.id } })).toBe(0);
    expect(await prisma.attendanceCheck.findUniqueOrThrow({ where: { rsvpId: order.rsvps[0]!.id } })).toMatchObject({ response: AttendanceResponse.ATTENDING, releaseOutcome: null, refundRequestId: null });
  });
});
