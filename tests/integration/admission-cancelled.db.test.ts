import { AdmissionMode, AdmissionStatus, EventStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email/admission", () => ({ sendAdmissionNoticeEmail: sent }));

import { prisma } from "@/lib/db";
import { draftDecisions, releaseDraftBatch } from "@/lib/admission/decisions";
import { runAdmissionMaintenance } from "@/lib/admission/maintenance";
import { autoDecide, promoteWaitlisted } from "@/lib/admission/promotion";
import { respondAsApplicant } from "@/lib/admission/respond";
import { deliverAdmissionNotice } from "@/lib/outbox/admission";
import { appOf, apply, createAdmissionEvent, decide, rsvpOf, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * A cancelled event and its applications (docs/ADMISSION.md "Offers"): no
 * acceptance, no new offers from any path or the beat, queued offer emails
 * dropped at delivery; decline and withdraw still work.
 */

const cancel = (eventId: string) => prisma.event.update({ where: { id: eventId }, data: { status: EventStatus.CANCELLED } });
const noticeRow = (applicationId: string, notice: string) =>
  prisma.outboxMessage.findFirstOrThrow({ where: { kind: "admission-notice", AND: [{ payload: { path: ["applicationId"], equals: applicationId } }, { payload: { path: ["notice"], equals: notice } }] } });

beforeAll(() => setUpAdmission("Cancelled applications"));
afterAll(() => tearDownAdmission());
beforeEach(() => sent.mockClear());

describe.sequential("applications on a cancelled event", () => {
  it("refuses accepting an offer once the event is cancelled, and still lets the applicant decline or withdraw", async () => {
    const { event, ctx } = await createAdmissionEvent({ capacity: 10 });
    const [a, b, c] = [await apply(event, "ana"), await apply(event, "ben"), await apply(event, "cai")];
    await decide(ctx, [a.application.id, b.application.id], "ACCEPT");
    await cancel(event.id);

    expect(await respondAsApplicant(a.token, "accept")).toEqual({ ok: false, error: expect.stringContaining("cancelled") });
    expect(await appOf(a.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED });
    expect((await rsvpOf(a.rsvp.id)).status).toBe(RsvpStatus.PENDING_APPROVAL);
    expect(await prisma.outboxMessage.count({ where: { kind: "rsvp-status", payload: { path: ["checkInToken"], equals: a.token } } })).toBe(0);

    expect(await respondAsApplicant(b.token, "decline")).toMatchObject({ ok: true, status: AdmissionStatus.DECLINED });
    expect(await respondAsApplicant(c.token, "withdraw")).toMatchObject({ ok: true, status: AdmissionStatus.WITHDRAWN });
  });

  it("makes no offers on a cancelled event: release, promotion, AUTO and the beat", async () => {
    const { event, ctx } = await createAdmissionEvent({ offerCapacity: 1 });
    const holder = await apply(event, "hol");
    const waiting = await apply(event, "wai");
    const fresh = await apply(event, "fre");
    await decide(ctx, [holder.application.id], "ACCEPT");
    await decide(ctx, [waiting.application.id], "WAITLIST");
    // The holder's offer is due a reminder, and has ended so its place frees up.
    await prisma.admissionApplication.update({ where: { id: holder.application.id }, data: { offeredAt: new Date(Date.now() - 3 * 86_400_000), respondBy: new Date(Date.now() + 3_600_000) } });
    await prisma.event.update({ where: { id: event.id }, data: { admissionMode: AdmissionMode.AUTO, admissionOfferCapacity: null } });
    await cancel(event.id);

    const drafted = await draftDecisions(ctx, { applicationIds: [fresh.application.id], outcome: "ACCEPT", overrideReason: "Testing without reviews" });
    expect(drafted.ok).toBe(true);
    expect(await releaseDraftBatch(ctx)).toEqual({ ok: false, error: expect.stringContaining("cancelled") });
    expect(await promoteWaitlisted(event.id)).toBe(0);
    expect(await autoDecide(event.id)).toBe(0);

    const pass = await runAdmissionMaintenance();
    expect(pass.promoted).toBe(0);
    expect(await appOf(holder.application.id)).toMatchObject({ status: AdmissionStatus.OFFERED, offerReminderSentAt: null });
    expect(await appOf(waiting.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED });
    expect(await appOf(fresh.application.id)).toMatchObject({ status: AdmissionStatus.IN_REVIEW });

    // An ended offer still expires, which frees nothing on a cancelled event.
    await prisma.admissionApplication.update({ where: { id: holder.application.id }, data: { respondBy: new Date(Date.now() - 60_000) } });
    expect(await runAdmissionMaintenance()).toMatchObject({ promoted: 0 });
    expect(await appOf(holder.application.id)).toMatchObject({ status: AdmissionStatus.EXPIRED });
    expect(await appOf(waiting.application.id)).toMatchObject({ status: AdmissionStatus.WAITLISTED });
  });

  it("drops an offer email still queued when the event is cancelled, and sends it otherwise", async () => {
    const { event, ctx } = await createAdmissionEvent({ capacity: 10 });
    const kept = await apply(event, "kep");
    const dropped = await apply(event, "dro");
    await decide(ctx, [kept.application.id, dropped.application.id], "ACCEPT");

    const live = await noticeRow(kept.application.id, "offer");
    expect(await deliverAdmissionNotice(live.payload, live.id)).toBe("sent");
    expect(sent).toHaveBeenCalledTimes(1);

    await cancel(event.id);
    const stale = await noticeRow(dropped.application.id, "offer");
    expect(await deliverAdmissionNotice(stale.payload, stale.id)).toBe("dropped");
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
