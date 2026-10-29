import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendNotice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/email/admission", () => ({ sendAdmissionNoticeEmail: sendNotice }));
const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => identity.id ? { user: { id: identity.id } } : null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn(), updateTag: vi.fn() }));

import { prisma } from "@/lib/db";
import { deliverAdmissionNotice } from "@/lib/outbox/admission";
import { respondAsApplicant } from "@/lib/admission/respond";
import { editApplicationAnswers } from "@/lib/admission/answers";
import { updateRsvpRegistration } from "@/app/actions/rsvp-admin";
import { apply, appOf, createAdmissionEvent, decide, paid, people, setUpAdmission, tearDownAdmission } from "./helpers/admission";
import { holdNextTransaction } from "./helpers/transactionBarrier";
import { waitForLockWait, whileLocked } from "./helpers/lockWait";

beforeAll(() => setUpAdmission("Holder admission"));
afterAll(() => tearDownAdmission());

async function behindHolderEdit(eventId: string, rsvpId: string, contender: () => Promise<unknown>) {
  identity.id = people.owner;
  const barrier = holdNextTransaction();
  const changing = updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId, rsvpId, name: "Replacement", guestEmail: `replacement-${rsvpId}@example.test`, answers: {} });
  let waiting: Promise<unknown> | undefined;
  try {
    const pid = await barrier.entered;
    waiting = contender();
    await waitForLockWait(pid);
  } finally {
    barrier.release();
    expect(await changing).toEqual({ ok: true });
    barrier.restore();
    identity.id = "";
  }
  return waiting;
}

describe.sequential("admission ticket authority after Event contention", () => {
  it("drops a queued application notice for the former holder", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const applicant = await apply(event, "notice");
    await decide(ctx, [applicant.application.id], "ACCEPT");
    const row = await prisma.outboxMessage.findFirstOrThrow({ where: { kind: "admission-notice", payload: { path: ["applicationId"], equals: applicant.application.id } } });
    expect(await deliverAdmissionNotice(row.payload, "<before@outbox.invalid>")).toBe("sent");
    sendNotice.mockClear();
    identity.id = people.owner;
    try {
      expect(await updateRsvpRegistration({ organisationSlug: paid.orgSlug, eventId: event.id, rsvpId: applicant.rsvp.id, guestEmail: `next-${applicant.rsvp.id}@example.test`, answers: {} })).toEqual({ ok: true });
    } finally { identity.id = ""; }
    expect(await deliverAdmissionNotice(row.payload, "<after@outbox.invalid>")).toBe("dropped");
    expect(sendNotice).not.toHaveBeenCalled();
  });
  it.each(["accept", "decline", "withdraw"] as const)("refuses an old-token %s already waiting behind an organiser holder change", async (action) => {
    const { event, ctx } = await createAdmissionEvent();
    const applicant = await apply(event, action);
    if (action !== "withdraw") await decide(ctx, [applicant.application.id], "ACCEPT");
    const before = await appOf(applicant.application.id);
    const result = await behindHolderEdit(event.id, applicant.rsvp.id, () => respondAsApplicant(applicant.token, action));
    expect(result).toEqual({ ok: false, error: "This ticket has no application." });
    expect(await appOf(before.id)).toMatchObject({ status: before.status, version: before.version });
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: applicant.rsvp.id } });
    expect((await respondAsApplicant(current.checkInToken, action)).ok).toBe(true);
  });

  it("refuses an old-token answer edit that was waiting behind a holder change", async () => {
    const { event } = await createAdmissionEvent();
    await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: { key: "why", label: "Why?", type: "TEXT" } } } });
    const applicant = await apply(event, "answers");
    expect(await behindHolderEdit(event.id, applicant.rsvp.id, () => editApplicationAnswers(applicant.token, { why: "Retired holder's answer" }))).toEqual({ ok: false, error: "This ticket has no application." });
    expect(await prisma.rsvpAnswer.count({ where: { rsvpId: applicant.rsvp.id } })).toBe(0);
    expect(await appOf(applicant.application.id)).toMatchObject({ answersRevision: 1 });
    const current = await prisma.rSVP.findUniqueOrThrow({ where: { id: applicant.rsvp.id } });
    expect(await editApplicationAnswers(current.checkInToken, { why: "Current holder's answer" })).toEqual({ ok: true });
  });

  it("rechecks current team leadership before answering with an unchanged token", async () => {
    const { event } = await createAdmissionEvent({ team: true });
    const leader = await apply(event, "leader", { team: { mode: "create", name: "Team" } });
    const team = await prisma.team.findUniqueOrThrow({ where: { id: leader.rsvp.teamId! } });
    const member = await apply(event, "member", { team: { mode: "join", joinToken: team.joinToken } });
    const result = await whileLocked(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${event.id} FOR UPDATE`;
      await tx.team.update({ where: { id: leader.rsvp.teamId! }, data: { leaderRsvpId: member.rsvp.id } });
    }, () => respondAsApplicant(leader.token, "withdraw"));
    expect(result).toEqual({ ok: false, error: "Only the team leader can answer for the team." });
    expect(await appOf(leader.application.id)).toMatchObject({ status: "IN_REVIEW" });
  });
});
