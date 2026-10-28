import { SubmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { approveClaim } from "@/lib/claims/decide";
import { POLICIES_PER_PASS, queueReimbursementNotices } from "@/lib/claims/policies/notices";
import { submitParticipantClaim } from "@/lib/claims/submit";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { deliverReimbursementAvailable, REIMBURSEMENT_AVAILABLE_KIND } from "@/lib/outbox/reimbursement";
import { checkIn, claimInput, ctx, finalsRound, freeEvent, mentoringRound, person, policy, setUpReimbursements, submission, team, tearDownReimbursements } from "./helpers/reimbursements";

/*
 * docs/FINANCE.md "Reimbursement policies": each stage kind, positive and
 * negative (judging round entries with finalists published, mentoring rounds
 * by Mentor Desk's rule), the ticket page listing only what applies, and the
 * once-per-person "reimbursement available" email.
 */

const claim = (token: string, amount: string, policyId: string) => submitParticipantClaim({ ticketToken: token, actorUserId: null }, claimInput(amount, policyId), []);
const offered = async (rsvp: { id: string; eventId: string | null; status: "CONFIRMED" | string }) =>
  ((await loadTicketClaims({ id: rsvp.id, eventId: rsvp.eventId, status: rsvp.status as "CONFIRMED" }))?.policies ?? []).map((row) => row.id);

beforeAll(() => setUpReimbursements("ReimbElig"));
afterAll(() => tearDownReimbursements());

describe.sequential("per-stage eligibility", () => {
  it("pays judging-round finalists only, once finalists are published, and re-checks a disqualification", async () => {
    const event = await freeEvent();
    const finals = await finalsRound(event);
    const finalist = await team(event);
    const other = await team(event);
    const [ana, ben] = [await person(event, { teamId: finalist.id }), await person(event, { teamId: finalist.id })];
    const cleo = await person(event, { teamId: other.id });
    const solo = await person(event);
    const finalistProject = await submission(event, { teamId: finalist.id });
    await submission(event, { teamId: other.id });
    const soloProject = await submission(event, { rsvpId: solo.id });
    await prisma.judgingRoundEntry.createMany({ data: [{ roundId: finals.id, submissionId: finalistProject.id }, { roundId: finals.id, submissionId: soloProject.id }] });
    const finalistTravel = await policy(event, { name: "Finalist travel", eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: finals.id, requireFinalistsPublished: true });

    expect(await offered(ana)).toEqual([]);
    expect(await claim(ana.checkInToken, "100", finalistTravel)).toMatchObject({ ok: false, error: expect.stringContaining("aren't published") });
    await prisma.judgingRound.update({ where: { id: finals.id }, data: { finalistsPublishedAt: new Date() } });
    expect(await offered(ana)).toEqual([finalistTravel]);
    expect(await offered(solo)).toEqual([finalistTravel]);
    expect(await offered(cleo)).toEqual([]);
    expect(await claim(cleo.checkInToken, "100", finalistTravel)).toMatchObject({ ok: false, error: expect.stringContaining("not in this round") });
    expect(await claim(ana.checkInToken, "100", finalistTravel)).toMatchObject({ ok: true });
    expect(await claim(ben.checkInToken, "100", finalistTravel)).toMatchObject({ ok: true });

    await prisma.submission.update({ where: { id: finalistProject.id }, data: { status: SubmissionStatus.DISQUALIFIED } });
    const anaClaim = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: ana.id } });
    expect(await approveClaim({ userId: ctx.ownerId, organisationId: ctx.organisationId }, { claimId: anaClaim.id })).toMatchObject({ ok: false, error: expect.stringContaining("disqualified") });
    expect(await offered(ben)).toEqual([]);
  });

  it("pays members of teams mentored in a round, not away teams, solo entrants or crew", async () => {
    const event = await freeEvent();
    const round = await mentoringRound(event);
    const [visited, away, unvisited] = [await team(event), await team(event), await team(event)];
    const [dina, eli, fay] = [await person(event, { teamId: visited.id }), await person(event, { teamId: away.id }), await person(event, { teamId: unvisited.id })];
    const solo = await person(event);
    const crewTicket = await person(event, { crew: true });
    await checkIn(event, round.id, visited.id);
    await checkIn(event, round.id, away.id, true);
    const mentored = await policy(event, { name: "Mentored travel", eligibility: "MENTORING_ROUND", mentoringRoundId: round.id });

    expect(await offered(dina)).toEqual([mentored]);
    for (const row of [eli, fay, solo, crewTicket]) expect(await offered(row)).toEqual([]);
    expect(await claim(dina.checkInToken, "100", mentored)).toMatchObject({ ok: true });
    expect(await claim(eli.checkInToken, "100", mentored)).toMatchObject({ ok: false, error: expect.stringContaining("hasn't taken part") });
    expect(await claim(solo.checkInToken, "100", mentored)).toMatchObject({ ok: false, error: expect.stringContaining("not in one") });
  });

  it("emails each person once when a policy opens to them, and drops a message that no longer applies", async () => {
    const event = await freeEvent();
    const finals = await finalsRound(event);
    const finalist = await team(event);
    const [gus, hal] = [await person(event, { teamId: finalist.id }), await person(event, { teamId: finalist.id })];
    await person(event);
    const project = await submission(event, { teamId: finalist.id });
    await prisma.judgingRoundEntry.create({ data: { roundId: finals.id, submissionId: project.id } });
    const quiet = await policy(event, { name: "Quiet", eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: finals.id });
    const notify = await policy(event, { name: "Finalist travel", eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: finals.id, requireFinalistsPublished: true, notifyWhenAvailable: true });

    await queueReimbursementNotices();
    expect(await prisma.reimbursementNotice.count({ where: { policyId: { in: [quiet, notify] } } })).toBe(0);
    await prisma.judgingRound.update({ where: { id: finals.id }, data: { finalistsPublishedAt: new Date() } });
    await Promise.all([queueReimbursementNotices(), queueReimbursementNotices()]);
    await queueReimbursementNotices();
    const notices = await prisma.reimbursementNotice.findMany({ where: { policyId: notify } });
    expect(notices.map((row) => row.rsvpId).sort()).toEqual([gus.id, hal.id].sort());
    const messages = await prisma.outboxMessage.findMany({ where: { kind: REIMBURSEMENT_AVAILABLE_KIND, createdAt: { gte: ctx.startedAt } } });
    const mine = messages.filter((row) => (row.payload as { policyId: string }).policyId === notify);
    expect(mine).toHaveLength(2);
    expect(JSON.stringify(mine[0]!.payload)).not.toContain(gus.checkInToken);

    expect(await deliverReimbursementAvailable(mine[0]!.payload, "<test@outbox.invalid>")).toBe("sent");
    await prisma.reimbursementPolicy.update({ where: { id: notify }, data: { active: false } });
    expect(await deliverReimbursementAvailable(mine[1]!.payload, "<test2@outbox.invalid>")).toBe("dropped");
    // A dropped email clears its notice, so the person is told once the policy is open again.
    const droppedFor = (mine[1]!.payload as { rsvpId: string }).rsvpId;
    expect(await prisma.reimbursementNotice.count({ where: { policyId: notify, rsvpId: droppedFor } })).toBe(0);
    await prisma.reimbursementPolicy.update({ where: { id: notify }, data: { active: true } });
    await queueReimbursementNotices();
    expect(await prisma.reimbursementNotice.findMany({ where: { policyId: notify }, select: { rsvpId: true } })).toHaveLength(2);
    await prisma.reimbursementPolicy.update({ where: { id: notify }, data: { active: false } });
    expect(await deliverReimbursementAvailable({ to: "x" }, "<bad@outbox.invalid>")).toBeNull();
  });

  it("reaches every policy across passes when there are more than a pass takes", async () => {
    const total = POLICIES_PER_PASS + 5;
    const ids: string[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const event = await freeEvent();
      await person(event);
      for (let index = batch * 20; index < Math.min(total, batch * 20 + 20); index += 1) {
        ids.push((await prisma.reimbursementPolicy.create({ data: { eventId: event.id, name: `P${index}`, eligibility: "CONFIRMED_PARTICIPANT", capPerPersonMinor: BigInt(100), categories: ["TRAVEL"], notifyWhenAvailable: true } })).id);
      }
    }
    const unchecked = () => prisma.reimbursementPolicy.count({ where: { id: { in: ids }, noticesCheckedAt: null } });
    await queueReimbursementNotices();
    expect(await unchecked()).toBeGreaterThanOrEqual(5);
    await queueReimbursementNotices();
    expect(await unchecked()).toBe(0);
    expect(await prisma.reimbursementNotice.count({ where: { policyId: { in: ids } } })).toBe(total);
  });
});
