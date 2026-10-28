import { describe, expect, it } from "vitest";
import { pairKey, planAssignments, type PlannerInput } from "@/lib/assignmentPlanner";
import {
  allowedOutcomes,
  countedReviewers,
  coverageMet,
  extensionRefusal,
  normaliseScores,
  offerCeiling,
  offersLeft,
  promotionOrder,
  registrationStatusFor,
  respondByFor,
} from "@/lib/admission/rules";

const DAY = 86_400_000;
const now = new Date("2030-01-01T00:00:00.000Z");

describe("admission state mapping", () => {
  it("mirrors each application status on its registrations", () => {
    expect(registrationStatusFor("IN_REVIEW")).toBe("PENDING_APPROVAL");
    expect(registrationStatusFor("OFFERED")).toBe("PENDING_APPROVAL");
    expect(registrationStatusFor("WAITLISTED")).toBe("WAITLISTED");
    expect(registrationStatusFor("ACCEPTED")).toBe("CONFIRMED");
    for (const closed of ["REJECTED", "DECLINED", "EXPIRED", "WITHDRAWN"] as const) expect(registrationStatusFor(closed)).toBe("REJECTED");
  });

  it("allows advancing only before the last stage, and only offers or declines from the waitlist", () => {
    expect(allowedOutcomes("IN_REVIEW", true)).toEqual(["ADVANCE", "ACCEPT", "WAITLIST", "REJECT"]);
    expect(allowedOutcomes("IN_REVIEW", false)).toEqual(["ACCEPT", "WAITLIST", "REJECT"]);
    expect(allowedOutcomes("WAITLISTED", true)).toEqual(["ACCEPT", "REJECT"]);
    expect(allowedOutcomes("OFFERED", true)).toEqual([]);
    expect(allowedOutcomes("ACCEPTED", false)).toEqual([]);
  });
});

describe("coverage", () => {
  const reviews = [
    { reviewerUserId: "a", answersRevision: 2 },
    { reviewerUserId: "a", answersRevision: 2 },
    { reviewerUserId: "b", answersRevision: 1 },
    { reviewerUserId: "c", answersRevision: 2 },
    { reviewerUserId: "d", answersRevision: 2 },
  ];
  it("counts distinct reviewers on the current answers who can still review and have no conflict", () => {
    const count = countedReviewers(reviews, 2, (id) => id !== "d", (id) => id === "c");
    expect(count).toBe(1);
    expect(countedReviewers(reviews, 2, () => true, () => false)).toBe(3);
  });
  it("needs the target or an override reason", () => {
    expect(coverageMet(1, 2, null)).toBe(false);
    expect(coverageMet(1, 2, "   ")).toBe(false);
    expect(coverageMet(1, 2, "Known speaker")).toBe(true);
    expect(coverageMet(2, 2, null)).toBe(true);
  });
});

describe("offers", () => {
  it("uses the offer capacity, else the event capacity, else no ceiling", () => {
    expect(offerCeiling({ admissionOfferCapacity: 5, capacity: 10 })).toBe(5);
    expect(offerCeiling({ admissionOfferCapacity: null, capacity: 10 })).toBe(10);
    expect(offerCeiling({ admissionOfferCapacity: null, capacity: null })).toBeNull();
    expect(offersLeft(5, 7)).toBe(0);
    expect(offersLeft(null, 7)).toBeNull();
  });
  it("gives an offer its days, never past the event start", () => {
    expect(respondByFor(now, 7, new Date(now.getTime() + 30 * DAY))).toEqual(new Date(now.getTime() + 7 * DAY));
    const start = new Date(now.getTime() + 2 * DAY);
    expect(respondByFor(now, 7, start)).toEqual(start);
  });
  it("extends only forward, before the start, by at most 30 days", () => {
    const start = new Date(now.getTime() + 60 * DAY);
    expect(extensionRefusal(now, null, new Date(now.getTime() - 1), start)).toMatch(/future/);
    expect(extensionRefusal(now, new Date(now.getTime() + 5 * DAY), new Date(now.getTime() + 4 * DAY), start)).toMatch(/later/);
    expect(extensionRefusal(now, null, new Date(now.getTime() + 61 * DAY), start)).toMatch(/start/);
    expect(extensionRefusal(now, null, new Date(now.getTime() + 31 * DAY), start)).toMatch(/30 days/);
    expect(extensionRefusal(now, null, new Date(now.getTime() + 3 * DAY), start)).toBeNull();
  });
});

describe("waitlist promotion order", () => {
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
  it("offers first in, first offered, skipping candidates that can't take a place", () => {
    const plan = promotionOrder([
      { id: "c", queuedAt: at(2), fits: true },
      { id: "a", queuedAt: at(1), fits: false, reason: "full type" },
      { id: "b", queuedAt: at(1), fits: true },
      { id: "d", queuedAt: at(3), fits: true },
    ], 2);
    expect(plan.offer).toEqual(["b", "c"]);
    expect(plan.skipped).toEqual([{ id: "a", reason: "full type" }]);
    expect(promotionOrder([{ id: "x", queuedAt: at(1), fits: true }], null).offer).toEqual(["x"]);
  });
});

describe("review scores", () => {
  it("needs every criterion scored 1 to 5 and nothing else", () => {
    expect(normaliseScores(["Impact", "Fit"], { Impact: 5, Fit: 1 })).toEqual({ Impact: 5, Fit: 1 });
    expect(normaliseScores(["Impact"], { Impact: 6 })).toBeNull();
    expect(normaliseScores(["Impact"], { Impact: 3, Extra: 2 })).toBeNull();
    expect(normaliseScores([], { overall: 4 })).toEqual({ overall: 4 });
    expect(normaliseScores([], { overall: 2.5 })).toBeNull();
  });
});

describe("seeded reviewer assignment", () => {
  const input = (seed: string | null): PlannerInput => ({
    itemIds: ["a1", "a2", "a3", "a4", "a5", "a6"],
    poolReviewerIds: ["r1", "r2", "r3"],
    perItem: 2,
    mode: "replace",
    existing: [],
    blocked: new Set([pairKey("r1", "a1")]),
    started: new Set(),
    canReview: () => true,
    seed,
  });
  it("gives the same plan for the same seed, and keeps blocked pairs out", () => {
    const seed = "0123456789abcdef0123456789abcdef";
    const first = planAssignments(input(seed));
    expect(planAssignments(input(seed))).toEqual(first);
    expect(first.add.some((pair) => pair.reviewerId === "r1" && pair.itemId === "a1")).toBe(false);
    expect(first.covered).toBe(6);
    const loads = first.loads.map((load) => load.after);
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
  });
  it("draws different plans for different seeds over enough inputs, and a BALANCED plan is seedless", () => {
    const seeds = ["00000000000000000000000000000000", "ffffffffffffffffffffffffffffffff", "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
    const fingerprints = new Set(seeds.map((seed) => planAssignments(input(seed)).fingerprint));
    expect(fingerprints.size).toBeGreaterThan(1);
    expect(planAssignments(input(null))).toEqual(planAssignments(input(null)));
  });
});
