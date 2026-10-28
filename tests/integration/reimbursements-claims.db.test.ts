import { ExpenseClaimStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { prisma } from "@/lib/db";
import { approveClaim } from "@/lib/claims/decide";
import { savePolicy } from "@/lib/claims/policies/manage";
import { readSnapshot } from "@/lib/claims/policies/snapshot";
import { submitParticipantClaim, withdrawClaim } from "@/lib/claims/submit";
import { loadTicketClaims } from "@/lib/claims/ticketView";
import { loadMyParticipantClaims, loadMyReimbursements } from "@/lib/mobile/attendee";
import { loadEventPolicies } from "@/lib/mobile/finance";
import { admin, claimInput, ctx, freeEvent, person, policy, setUpReimbursements, tearDownReimbursements } from "./helpers/reimbursements";

/*
 * docs/FINANCE.md "Reimbursement policies": claims under a policy on a free
 * event: cap per person per policy, budget under concurrency, window and
 * categories, the frozen snapshot, re-checks at approval, and general claims
 * left as they were.
 */

const claim = (token: string, amount: string, policyId: string, category = "TRAVEL") => submitParticipantClaim({ ticketToken: token, actorUserId: null }, claimInput(amount, policyId, category), []);
const approver = () => ({ userId: ctx.ownerId, organisationId: ctx.organisationId });

beforeAll(() => setUpReimbursements("ReimbClaims"));
afterAll(() => tearDownReimbursements());

describe.sequential("claims under a reimbursement policy", () => {
  it("caps each person per policy on a free event, separately from other policies and general claims", async () => {
    const event = await freeEvent();
    await prisma.event.update({ where: { id: event.id }, data: { participantClaimsEnabled: true, participantClaimCapMinor: BigInt(50000) } });
    const travel = await policy(event, { cap: "1000" });
    const stay = await policy(event, { name: "Stay", cap: "800", categories: ["ACCOMMODATION"] });
    const alice = await person(event);
    expect(await prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: { currency: true } })).toEqual({ currency: "INR" });

    expect(await claim(alice.checkInToken, "600", travel)).toMatchObject({ ok: true });
    expect(await claim(alice.checkInToken, "500", travel)).toMatchObject({ ok: false, error: expect.stringContaining("is left") });
    expect(await claim(alice.checkInToken, "400", travel)).toMatchObject({ ok: true });
    expect(await claim(alice.checkInToken, "300", stay, "TRAVEL")).toMatchObject({ ok: false, error: expect.stringContaining("doesn't cover") });
    expect(await claim(alice.checkInToken, "800", stay, "ACCOMMODATION")).toMatchObject({ ok: true });
    // General claims keep their own cap and ignore policy claims.
    expect(await submitParticipantClaim({ ticketToken: alice.checkInToken, actorUserId: null }, { category: "FOOD", description: "Lunch", amount: "500" }, [])).toMatchObject({ ok: true });
    expect(await submitParticipantClaim({ ticketToken: alice.checkInToken, actorUserId: null }, { category: "FOOD", description: "Dinner", amount: "1" }, [])).toMatchObject({ ok: false });

    const filed = await prisma.expenseClaim.findMany({ where: { rsvpId: alice.id }, orderBy: { createdAt: "asc" } });
    expect(filed.map((row) => row.policyId)).toEqual([travel, travel, stay, null]);
    expect(filed[3]!.eligibilitySnapshot).toBeNull();
    const snapshot = readSnapshot(filed[0]!.eligibilitySnapshot);
    expect(snapshot?.terms).toMatchObject({ policyId: travel, capPerPersonMinor: "100000", eligibility: "CONFIRMED_PARTICIPANT" });
    expect(snapshot?.submitted).toMatchObject({ eligible: true, facts: { registrationStatus: "CONFIRMED" } });
    // Withdrawn claims stop counting.
    expect(await withdrawClaim(filed[1]!.id, { userId: null, rsvpId: alice.id })).toMatchObject({ ok: true });
    expect(await claim(alice.checkInToken, "400", travel)).toMatchObject({ ok: true });
  });

  it("never lets concurrent claims overspend the policy budget", async () => {
    const event = await freeEvent();
    const pool = await policy(event, { cap: "1000", budget: "2500" });
    const people = await Promise.all(Array.from({ length: 5 }, () => person(event)));
    const results = await Promise.all(people.map((row) => claim(row.checkInToken, "1000", pool)));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.filter((result) => !result.ok).every((result) => !result.ok && /left to pay out|whole budget/.test(result.error))).toBe(true);
    const total = await prisma.expenseClaim.aggregate({ where: { policyId: pool, status: ExpenseClaimStatus.SUBMITTED }, _sum: { amountMinor: true } });
    expect(total._sum.amountMinor).toBe(BigInt(200000));
  });

  it("honours the claim window, the active switch and confirmed status", async () => {
    const event = await freeEvent();
    const later = await policy(event, { claimOpensAt: "2099-01-01T10:00" });
    const closed = await policy(event, { name: "Old", active: false });
    const open = await policy(event, { name: "Open" });
    const bob = await person(event);
    const waiting = await person(event, { status: RsvpStatus.WAITLISTED });
    expect(await claim(bob.checkInToken, "10", later)).toMatchObject({ ok: false, error: expect.stringContaining("aren't open yet") });
    expect(await claim(bob.checkInToken, "10", closed)).toMatchObject({ ok: false, error: expect.stringContaining("isn't open") });
    expect(await claim(waiting.checkInToken, "10", open)).toMatchObject({ ok: false });
    const view = await loadTicketClaims({ id: bob.id, eventId: event.id, status: bob.status });
    expect(view?.general).toBe(false);
    expect(view?.policies.map((row) => row.id)).toEqual([open]);
    expect(view?.policies[0]).toMatchObject({ left: expect.stringContaining("1,000") });
  });

  it("lets crew claim only under crew policies", async () => {
    const event = await freeEvent();
    const everyone = await policy(event);
    const crewPolicy = await policy(event, { name: "Crew travel", eligibility: "CREW" });
    const crewTicket = await person(event, { crew: true });
    expect(await claim(crewTicket.checkInToken, "100", everyone)).toMatchObject({ ok: false });
    expect(await claim(crewTicket.checkInToken, "100", crewPolicy)).toMatchObject({ ok: true });
    expect(await prisma.expenseClaim.findFirstOrThrow({ where: { policyId: crewPolicy } })).toMatchObject({ kind: "CREW" });
  });

  it("re-checks eligibility and the frozen cap at approval, and records the approval check", async () => {
    const event = await freeEvent();
    const attended = await policy(event, { cap: "1000", attendanceRequired: true });
    const carol = await person(event, { checkedIn: true });
    const dave = await person(event);
    expect(await claim(dave.checkInToken, "100", attended)).toMatchObject({ ok: false, error: expect.stringContaining("checked in") });
    expect(await claim(carol.checkInToken, "700", attended)).toMatchObject({ ok: true });
    expect(await claim(carol.checkInToken, "300", attended)).toMatchObject({ ok: true });
    const [first, second] = await prisma.expenseClaim.findMany({ where: { rsvpId: carol.id }, orderBy: { createdAt: "asc" } });

    // A later policy edit doesn't change the terms the claims were filed under.
    expect(await savePolicy(admin(event), { policyId: attended, name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", cap: "200", categories: ["TRAVEL"], attendanceRequired: true })).toMatchObject({ ok: true });
    expect(await approveClaim(approver(), { claimId: first!.id })).toMatchObject({ ok: true });
    const approved = readSnapshot((await prisma.expenseClaim.findUniqueOrThrow({ where: { id: first!.id } })).eligibilitySnapshot);
    expect(approved).toMatchObject({ terms: { capPerPersonMinor: "100000" }, approved: { eligible: true } });

    // Check-in undone: approval is refused until it is met again.
    await prisma.rSVP.update({ where: { id: carol.id }, data: { checkedInAt: null } });
    expect(await approveClaim(approver(), { claimId: second!.id })).toMatchObject({ ok: false, error: expect.stringContaining("No longer eligible") });
    await prisma.rSVP.update({ where: { id: carol.id }, data: { checkedInAt: new Date() } });
    expect(await approveClaim(approver(), { claimId: second!.id })).toMatchObject({ ok: true });
  });

  it("refuses an approval that would overspend the current budget", async () => {
    const event = await freeEvent();
    const pool = await policy(event, { cap: "1000", budget: "1500" });
    const [erin, frank] = await Promise.all([person(event), person(event)]);
    expect(await claim(erin.checkInToken, "1000", pool)).toMatchObject({ ok: true });
    expect(await claim(frank.checkInToken, "500", pool)).toMatchObject({ ok: true });
    expect(await savePolicy(admin(event), { policyId: pool, name: "Travel", eligibility: "CONFIRMED_PARTICIPANT", cap: "1000", budget: "1200", categories: ["TRAVEL"] })).toMatchObject({ ok: true });
    const erinClaim = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: erin.id } });
    const frankClaim = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: frank.id } });
    expect(await approveClaim(approver(), { claimId: erinClaim.id })).toMatchObject({ ok: true });
    expect(await approveClaim(approver(), { claimId: frankClaim.id })).toMatchObject({ ok: false, error: expect.stringContaining("over its budget") });
    expect(await approveClaim(approver(), { claimId: frankClaim.id, amount: "200" })).toMatchObject({ ok: true });
  });

  it("leaves general participant claims and approvals exactly as before", async () => {
    const event = await freeEvent();
    await prisma.event.update({ where: { id: event.id }, data: { participantClaimsEnabled: true, participantClaimCapMinor: BigInt(100000) } });
    const gina = await person(event);
    expect(await submitParticipantClaim({ ticketToken: gina.checkInToken, actorUserId: null }, { category: "TRAVEL", description: "Bus", amount: "900" }, [])).toMatchObject({ ok: true });
    const row = await prisma.expenseClaim.findFirstOrThrow({ where: { rsvpId: gina.id } });
    expect(row).toMatchObject({ policyId: null, eligibilitySnapshot: null, kind: "PARTICIPANT" });
    expect(await approveClaim(approver(), { claimId: row.id, amount: "800" })).toMatchObject({ ok: true });
    expect(await loadTicketClaims({ id: gina.id, eventId: event.id, status: gina.status })).toMatchObject({ general: true, policies: [], cap: expect.stringContaining("1,000") });
  });

  it("serves the mobile reimbursements and organiser policy list from the same rules", async () => {
    const event = await freeEvent();
    const travel = await policy(event, { cap: "1000", budget: "5000" });
    await policy(event, { name: "Crew", eligibility: "CREW" });
    const owner = await prisma.user.findUniqueOrThrow({ where: { id: ctx.memberId } });
    const mine = await prisma.rSVP.create({ data: { eventId: event.id, userId: owner.id, attendeeKey: `user:${owner.id}`, status: RsvpStatus.CONFIRMED } });
    expect(await loadMyReimbursements(ctx.ownerId, mine.id)).toBeUndefined();
    expect(await loadMyReimbursements(ctx.memberId, mine.id)).toEqual({ currency: "INR", general: null, policies: [expect.objectContaining({ id: travel, left: expect.stringContaining("1,000") })] });
    expect(await submitParticipantClaim({ ticketToken: mine.checkInToken, actorUserId: ctx.memberId }, claimInput("250", travel), [])).toMatchObject({ ok: true });
    expect((await loadMyParticipantClaims(ctx.memberId, mine.id))?.claims[0]).toMatchObject({ policy: "Travel", status: "SUBMITTED" });
    const list = await loadEventPolicies(event.id);
    expect(list.policies).toHaveLength(2);
    expect(list.policies[0]).toMatchObject({ id: travel, eligibility: "CONFIRMED_PARTICIPANT", used: expect.stringContaining("250"), budgetLeft: expect.stringContaining("4,750"), claims: 1, window: "open" });
  });
});
