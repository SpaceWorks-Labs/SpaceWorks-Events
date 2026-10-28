import { ReimbursementEligibility, RsvpStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/mentorDesk/rounds", () => ({
  tookPartInRound: vi.fn(async (_client: unknown, params: { teamId?: string | null }) => params.teamId === "team-in"),
  teamsThatTookPartInRound: vi.fn(async () => new Set(["team-in"])),
}));

import { ELIGIBILITY_RESOLVERS, evaluateEligibility, stageColumn, type Claimant, type EligibilityTerms } from "@/lib/claims/policies/eligibility";
import { approvalProblem, countedMinor, remaining, sumCounted, sumDecided, windowState } from "@/lib/claims/policies/math";
import { eligibilityTerms, freezeTerms, readSnapshot, recordCheck, snapshotJson } from "@/lib/claims/policies/snapshot";
import { ELIGIBILITY_LABELS, ELIGIBILITY_STAGE } from "@/lib/claims/policyLabels";

/* docs/FINANCE.md "Reimbursement policies": cap/budget math, frozen snapshots and the resolver registry. */

const n = (value: number) => BigInt(value);

describe("reimbursement cap and budget math", () => {
  it("counts waiting claims at the amount asked and decided ones at the amount approved", () => {
    expect(countedMinor({ status: "SUBMITTED", amountMinor: n(500), approvedMinor: null })).toBe(n(500));
    expect(countedMinor({ status: "APPROVED", amountMinor: n(500), approvedMinor: n(300) })).toBe(n(300));
    expect(countedMinor({ status: "PAID", amountMinor: n(500), approvedMinor: n(400) })).toBe(n(400));
    expect(countedMinor({ status: "REJECTED", amountMinor: n(500), approvedMinor: null })).toBe(n(0));
    expect(countedMinor({ status: "WITHDRAWN", amountMinor: n(500), approvedMinor: null })).toBe(n(0));
    const claims = [{ status: "SUBMITTED", amountMinor: n(100), approvedMinor: null }, { status: "APPROVED", amountMinor: n(200), approvedMinor: n(150) }];
    expect(sumCounted(claims)).toBe(n(250));
    expect(sumDecided(claims)).toBe(n(150));
  });

  it("leaves the smaller of the person's cap and the policy's budget, never below zero", () => {
    expect(remaining({ capPerPerson: n(1000), personUsed: n(400), budget: null, budgetUsed: n(0) })).toEqual({ person: n(600), budget: null, left: n(600) });
    expect(remaining({ capPerPerson: n(1000), personUsed: n(0), budget: n(5000), budgetUsed: n(4700) })).toEqual({ person: n(1000), budget: n(300), left: n(300) });
    expect(remaining({ capPerPerson: n(1000), personUsed: n(1200), budget: n(100), budgetUsed: n(900) })).toEqual({ person: n(0), budget: n(0), left: n(0) });
  });

  it("knows when the claim window is open", () => {
    const now = new Date("2030-01-10T00:00:00Z");
    expect(windowState({ claimOpensAt: null, claimClosesAt: null }, now)).toBe("open");
    expect(windowState({ claimOpensAt: new Date("2030-01-11T00:00:00Z"), claimClosesAt: null }, now)).toBe("upcoming");
    expect(windowState({ claimOpensAt: null, claimClosesAt: now }, now)).toBe("closed");
  });

  it("keeps an approval within the frozen cap and the current budget", () => {
    expect(approvalProblem({ approvedMinor: n(300), cap: n(1000), personDecided: n(700), budget: null, budgetDecided: n(0) })).toBeNull();
    expect(approvalProblem({ approvedMinor: n(301), cap: n(1000), personDecided: n(700), budget: null, budgetDecided: n(0) })).toBe("cap");
    expect(approvalProblem({ approvedMinor: n(300), cap: n(1000), personDecided: n(0), budget: n(1000), budgetDecided: n(800) })).toBe("budget");
  });
});

const policy = {
  id: "p1", name: "Finalist travel", eligibility: ReimbursementEligibility.JUDGING_ROUND_ENTRY, judgingRoundId: "r1", mentoringRoundId: null,
  requireFinalistsPublished: true, attendanceRequired: true, crewKinds: [], capPerPersonMinor: n(500000), categories: ["TRAVEL" as const], claimOpensAt: null, claimClosesAt: new Date("2030-01-01T00:00:00Z"),
};

describe("frozen policy terms", () => {
  it("round-trips through the snapshot and rejects anything else", () => {
    const terms = freezeTerms(policy);
    const json = snapshotJson({ version: 1, terms, submitted: recordCheck({ eligible: true, reason: null, facts: { checkedIn: true } }, new Date("2029-12-01T00:00:00Z")) });
    const read = readSnapshot(json as never);
    expect(read?.terms).toEqual({ ...terms, capPerPersonMinor: "500000", claimClosesAt: "2030-01-01T00:00:00.000Z" });
    expect(eligibilityTerms(read!.terms)).toEqual({ eligibility: "JUDGING_ROUND_ENTRY", judgingRoundId: "r1", mentoringRoundId: null, requireFinalistsPublished: true, attendanceRequired: true, crewKinds: [] });
    expect(readSnapshot({ version: 2 } as never)).toBeNull();
    expect(readSnapshot(null)).toBeNull();
    expect(() => snapshotJson({ ...read!, terms: { ...read!.terms, capPerPersonMinor: "-1" } })).toThrow();
  });
});

const person = (overrides: Partial<Claimant> = {}): Claimant => ({ rsvpId: "rsvp", eventId: "event", status: RsvpStatus.CONFIRMED, isCrew: false, teamId: null, checkedInAt: new Date(), ...overrides });
const terms = (overrides: Partial<EligibilityTerms> = {}): EligibilityTerms => ({ eligibility: ReimbursementEligibility.CONFIRMED_PARTICIPANT, judgingRoundId: null, mentoringRoundId: null, requireFinalistsPublished: false, attendanceRequired: false, crewKinds: [], ...overrides });

/** A minimal Prisma stand-in for the judging resolver. */
function judgingClient(submission: { status: string; inRound: boolean } | null, publishedAt: Date | null) {
  return {
    judgingRound: { findFirst: async () => ({ finalistsPublishedAt: publishedAt }) },
    submission: { findFirst: async () => (submission ? { id: "s1", status: submission.status, roundEntries: submission.inRound ? [{ id: "e" }] : [] } : null) },
  } as never;
}

describe("eligibility resolvers", () => {
  it("has one resolver, label and stage picker per kind", () => {
    for (const kind of Object.values(ReimbursementEligibility)) {
      expect(ELIGIBILITY_RESOLVERS[kind]).toBeDefined();
      expect(ELIGIBILITY_LABELS[kind]).toBeTruthy();
      expect(ELIGIBILITY_STAGE[kind] === null).toBe(stageColumn(kind) === null);
    }
  });

  it("needs a confirmed registration, and a check-in when attendance is required", async () => {
    const client = {} as never;
    expect(await evaluateEligibility(client, person(), terms())).toMatchObject({ eligible: true });
    expect(await evaluateEligibility(client, person({ status: RsvpStatus.WAITLISTED }), terms())).toMatchObject({ eligible: false, reason: expect.stringContaining("no longer confirmed") });
    expect(await evaluateEligibility(client, person({ checkedInAt: null }), terms({ attendanceRequired: true }))).toMatchObject({ eligible: false, reason: expect.stringContaining("checked in") });
  });

  it("separates participants from crew", async () => {
    const client = {} as never;
    expect((await evaluateEligibility(client, person({ isCrew: true }), terms())).eligible).toBe(false);
    expect((await evaluateEligibility(client, person({ isCrew: true }), terms({ eligibility: ReimbursementEligibility.CREW }))).eligible).toBe(true);
    expect((await evaluateEligibility(client, person(), terms({ eligibility: ReimbursementEligibility.CREW }))).eligible).toBe(false);
  });

  it("limits a crew policy to its crew kinds when it names any", async () => {
    const volunteers = terms({ eligibility: ReimbursementEligibility.CREW, crewKinds: ["VOLUNTEER"] });
    const client = (kind: string | null) => ({ eventCrewMember: { findUnique: async () => (kind ? { kind } : null) } }) as never;
    expect((await evaluateEligibility(client("VOLUNTEER"), person({ isCrew: true }), volunteers)).eligible).toBe(true);
    expect((await evaluateEligibility(client("MENTOR"), person({ isCrew: true }), volunteers)).reason).toContain("other crew roles");
    expect((await evaluateEligibility(client(null), person({ isCrew: true }), volunteers)).eligible).toBe(false);
    expect(await ELIGIBILITY_RESOLVERS.CREW.candidates({} as never, "event", volunteers)).toEqual({ isCrew: true, crewMember: { kind: { in: ["VOLUNTEER"] } } });
    expect(await ELIGIBILITY_RESOLVERS.CREW.candidates({} as never, "event", terms({ eligibility: ReimbursementEligibility.CREW }))).toEqual({ isCrew: true });
  });

  it("qualifies a judging round's entries unless withdrawn, disqualified or unpublished", async () => {
    const round = terms({ eligibility: ReimbursementEligibility.JUDGING_ROUND_ENTRY, judgingRoundId: "r1" });
    const published = new Date();
    expect((await evaluateEligibility(judgingClient({ status: "SUBMITTED", inRound: true }, null), person(), round)).eligible).toBe(true);
    expect((await evaluateEligibility(judgingClient({ status: "SUBMITTED", inRound: false }, null), person(), round)).reason).toContain("not in this round");
    expect((await evaluateEligibility(judgingClient({ status: "DISQUALIFIED", inRound: true }, null), person(), round)).reason).toContain("disqualified");
    expect((await evaluateEligibility(judgingClient({ status: "WITHDRAWN", inRound: true }, null), person(), round)).reason).toContain("withdrawn");
    expect((await evaluateEligibility(judgingClient(null, null), person(), round)).eligible).toBe(false);
    const finalists = { ...round, requireFinalistsPublished: true };
    expect((await evaluateEligibility(judgingClient({ status: "SUBMITTED", inRound: true }, null), person(), finalists)).reason).toContain("aren't published");
    expect((await evaluateEligibility(judgingClient({ status: "SUBMITTED", inRound: true }, published), person(), finalists)).eligible).toBe(true);
  });

  it("qualifies members of teams that took part in a mentoring round", async () => {
    const round = terms({ eligibility: ReimbursementEligibility.MENTORING_ROUND, mentoringRoundId: "m1" });
    expect((await evaluateEligibility({} as never, person({ teamId: "team-in" }), round)).eligible).toBe(true);
    expect((await evaluateEligibility({} as never, person({ teamId: "team-out" }), round)).eligible).toBe(false);
    expect((await evaluateEligibility({} as never, person(), round)).reason).toContain("not in one");
    expect(await ELIGIBILITY_RESOLVERS.MENTORING_ROUND.candidates({} as never, "event", round)).toEqual({ isCrew: false, teamId: { in: ["team-in"] } });
  });
});
