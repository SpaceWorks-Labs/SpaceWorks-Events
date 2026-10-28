import { AdmissionStatus, EventPrivacyType, RsvpStatus, type Event } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { deleteStage } from "@/lib/admission/stages";
import { approveClaim } from "@/lib/claims/decide";
import { eligibleRegistrationIds } from "@/lib/claims/policies/eligibility";
import { admissionStage } from "@/lib/claims/policies/eligibility/admissionStage";
import { savePolicy } from "@/lib/claims/policies/manage";
import { policyStageOptions } from "@/lib/claims/policies/view";
import { submitParticipantClaim } from "@/lib/claims/submit";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { admin, claimInput, ctx, freeEvent, person, setUpReimbursements, team, tearDownReimbursements } from "./helpers/reimbursements";

/*
 * docs/FINANCE.md "Reimbursement policies", ADMISSION_STAGE: applicants
 * whose application (the team's for a team member) reached an admission
 * stage and was accepted (never one still in review, offered or waitlisted); the stage kept
 * to the policy's event; a stage a policy is for can't be deleted.
 */

const claim = (token: string, policyId: string) => submitParticipantClaim({ ticketToken: token, actorUserId: null }, claimInput("100", policyId), []);
const offered = async (rsvp: { id: string; eventId: string | null; status: RsvpStatus }) => ((await loadTicketClaims(rsvp))?.policies ?? []).map((row) => row.id);
const base = { eligibility: "ADMISSION_STAGE", cap: "1000", categories: ["TRAVEL"] };

/** An event taking applications with stages 1 and 2 (applications are opened by triggers on registration). */
async function admissionEvent() {
  const event = await freeEvent();
  await prisma.event.update({ where: { id: event.id }, data: { admissionEnabled: true, privacyType: EventPrivacyType.APPROVAL_REQUIRED } });
  await prisma.admissionStage.create({ data: { eventId: event.id, position: 1, name: "Screening" } });
  const finals = await prisma.admissionStage.create({ data: { eventId: event.id, position: 2, name: "Interview" } });
  return { event: event as Event, finals };
}

async function advance(stageId: string, where: { rsvpId?: string; teamId?: string }) {
  const application = await prisma.admissionApplication.findFirstOrThrow({ where });
  await prisma.admissionStageEntry.create({ data: { stageId, applicationId: application.id, source: "ADVANCED" } });
  return application;
}

beforeAll(() => setUpReimbursements("ReimbAdm"));
afterAll(() => tearDownReimbursements());

describe.sequential("admission-stage reimbursement policies", () => {
  it("pays accepted applicants who reached the stage, team members through their team's application, and nobody still in play", async () => {
    const { event, finals } = await admissionEvent();
    // On an event taking applications everyone applies (pending) first.
    const pending = { status: RsvpStatus.PENDING_APPROVAL };
    const accepted = await team(event, RsvpStatus.PENDING_APPROVAL);
    let [ada, bo] = [await person(event, { ...pending, teamId: accepted.id }), await person(event, { ...pending, teamId: accepted.id })];
    let early = await person(event, pending);
    const reviewing = await person(event, pending);
    const offeredOne = await person(event, pending);
    const waiting = await person(event, pending);
    // The accepted team and an applicant accepted at stage 1 hold confirmed places.
    await prisma.admissionApplication.updateMany({ where: { OR: [{ teamId: accepted.id }, { rsvpId: early.id }] }, data: { status: AdmissionStatus.ACCEPTED } });
    await prisma.team.update({ where: { id: accepted.id }, data: { status: RsvpStatus.CONFIRMED } });
    [ada, bo, early] = await Promise.all([ada, bo, early].map((row) => prisma.rSVP.update({ where: { id: row.id }, data: { status: RsvpStatus.CONFIRMED } })));
    // Three more reached the stage and are still in play: in review, offered, waitlisted (their registrations pending or waitlisted).
    await advance(finals.id, { teamId: accepted.id });
    await advance(finals.id, { rsvpId: reviewing.id });
    const offer = await advance(finals.id, { rsvpId: offeredOne.id });
    await prisma.admissionApplication.update({ where: { id: offer.id }, data: { status: AdmissionStatus.OFFERED, offeredAt: new Date(), respondBy: new Date(Date.now() + 86_400_000) } });
    const queued = await advance(finals.id, { rsvpId: waiting.id });
    await prisma.admissionApplication.update({ where: { id: queued.id }, data: { status: AdmissionStatus.WAITLISTED, queuedAt: new Date() } });
    const waitingRsvp = await prisma.rSVP.update({ where: { id: waiting.id }, data: { status: RsvpStatus.WAITLISTED } });

    const saved = await savePolicy(admin(event), { ...base, name: "Interview travel", admissionStageId: finals.id });
    if (!saved.ok) throw new Error(saved.error);
    const interview = saved.data.policyId;
    expect(await prisma.reimbursementPolicy.findUniqueOrThrow({ where: { id: interview } })).not.toHaveProperty("requireAccepted");

    expect(await offered(ada)).toEqual([interview]);
    expect(await offered(early)).toEqual([]);
    for (const row of [reviewing, offeredOne, waitingRsvp]) {
      expect(await offered(row)).toEqual([]);
      expect(await claim(row.checkInToken, interview)).toMatchObject({ ok: false });
    }
    expect(await claim(early.checkInToken, interview)).toMatchObject({ ok: false, error: expect.stringContaining("hasn't reached this stage") });
    // The resolver itself refuses an application that reached the stage but isn't accepted.
    const terms = { eligibility: "ADMISSION_STAGE" as const, judgingRoundId: null, mentoringRoundId: null, admissionStageId: finals.id, requireFinalistsPublished: false, attendanceRequired: false, crewKinds: [] };
    for (const row of [reviewing, offeredOne, waitingRsvp]) {
      const claimant = { rsvpId: row.id, eventId: event.id, status: RsvpStatus.CONFIRMED, isCrew: false, teamId: null, checkedInAt: null };
      expect(await admissionStage.evaluate(prisma, claimant, terms)).toMatchObject({ eligible: false, reason: expect.stringContaining("hasn't been accepted") });
    }
    expect(await claim(ada.checkInToken, interview)).toMatchObject({ ok: true });
    expect(await claim(bo.checkInToken, interview)).toMatchObject({ ok: true });
    expect(new Set(await eligibleRegistrationIds(prisma, event.id, terms, 50))).toEqual(new Set([ada.id, bo.id]));

    // A withdrawn application no longer qualifies, also at approval.
    await prisma.admissionApplication.update({ where: { teamId: accepted.id }, data: { status: AdmissionStatus.WITHDRAWN } });
    expect(await offered(bo)).toEqual([]);
    const adaClaim = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: ada.id } });
    expect(await approveClaim({ userId: ctx.ownerId, organisationId: ctx.organisationId }, { claimId: adaClaim.id })).toMatchObject({ ok: false, error: expect.stringContaining("hasn't reached this stage") });
  });

  it("keeps the stage to the policy's event and to events taking applications", async () => {
    const { event, finals } = await admissionEvent();
    const other = await admissionEvent();
    const plain = await freeEvent();
    expect(await savePolicy(admin(event), { ...base, name: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("admission stage") });
    expect(await savePolicy(admin(event), { ...base, name: "x", admissionStageId: other.finals.id })).toMatchObject({ ok: false });
    expect(await savePolicy(admin(plain), { ...base, name: "x", admissionStageId: finals.id })).toMatchObject({ ok: false });
    const row = { eventId: event.id, name: "Raw", capPerPersonMinor: BigInt(1), categories: ["TRAVEL" as const] };
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "ADMISSION_STAGE", admissionStageId: other.finals.id } })).rejects.toThrow(/another event/);
    await expect(prisma.reimbursementPolicy.create({ data: { ...row, eligibility: "ADMISSION_STAGE" } })).rejects.toThrow();
    expect((await policyStageOptions(prisma, event.id)).admissionStages.map((stage) => stage.id)).toContain(finals.id);
    expect((await policyStageOptions(prisma, plain.id)).admissionStages).toEqual([]);
  });

  it("refuses to delete a stage a policy is for", async () => {
    const { event } = await admissionEvent();
    const last = await prisma.admissionStage.create({ data: { eventId: event.id, position: 3, name: "Final" } });
    const saved = await savePolicy(admin(event), { ...base, name: "Final travel", admissionStageId: last.id });
    expect(saved).toMatchObject({ ok: true });
    const admissionCtx = { userId: ctx.ownerId, organisationId: ctx.organisationId, eventId: event.id } as Parameters<typeof deleteStage>[0];
    expect(await deleteStage(admissionCtx, last.id)).toMatchObject({ ok: false, error: expect.stringContaining("reimbursement policy") });
    await expect(prisma.admissionStage.delete({ where: { id: last.id } })).rejects.toThrow();
    await prisma.reimbursementPolicy.delete({ where: { id: saved.ok ? saved.data.policyId : "" } });
    expect(await deleteStage(admissionCtx, last.id)).toMatchObject({ ok: true });
  });
});
