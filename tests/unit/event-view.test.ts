import { describe, expect, it, vi } from "vitest";
import { EventPrivacyType, EventStatus, JudgingStatus, RegistrationMode, SoloPolicy, type Event } from "@prisma/client";
import { eventForView } from "@/lib/frontend/eventView";
import { toEventClientDto } from "@/lib/eventDto";

vi.mock("@/lib/frontend/peer", () => ({ isFrontendPeer: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: vi.fn() }));
vi.mock("@/lib/frontend/registry", () => ({ viewReaders: {}, backendActions: {} }));
import { assertSafeView } from "@/lib/frontend/handler";

function teamEvent() {
  return {
    id: "event_1", organisationId: "org_1", title: "Hack", slug: "hack", description: "", tags: [],
    showRegistrationCount: true, coverImageUrl: null,
    startDateTime: new Date("2035-01-01T10:00:00Z"), endDateTime: new Date("2035-01-01T12:00:00Z"),
    timezone: "UTC", location: "Venue", mapLinkUrl: null, isOnline: false, capacity: 40,
    status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC, listedPublicly: false,
    registrationClosesAt: null, registrationLeadMinutes: null,
    currency: "INR", refundPolicyKind: "PERCENT_UNTIL", refundPolicyHours: 48, refundPolicyPercent: 50,
    refundPolicyText: "Half back", allowTransfers: true, transferCutoffHours: 12,
    registrationMode: RegistrationMode.TEAM, teamMinSize: 2, teamMaxSize: 4,
    soloPolicy: SoloPolicy.TEAMS_ONLY, teamTicketMode: "PER_TEAM",
    submissionsEnabled: true, submissionsOpenAt: null, submissionsCloseAt: null,
    judgingStatus: JudgingStatus.OPEN, judgesSeeAll: false, projectGalleryPublic: false,
    resultsPublishedAt: new Date("2035-01-02T00:00:00Z"), resultsAnnouncedAt: null,
    reviewsPerProject: 3, scoreNormalization: "ZSCORE", currentJudgingRoundId: "round_1",
    emailEntrantsOnResults: true, emailSubmissionReceipts: true,
    submissionFeeMinor: BigInt(500), submissionFeeRefundOnDisqualify: false,
    budgetMinor: BigInt(100000), participantClaimsEnabled: true, participantClaimCapMinor: null, crewClaimsEnabled: false, attendanceCheckReleaseOnDecline: true,
    ticketDesignId: "design_1", shortCode: "AB12CD3",
    checkInStationPinHash: "bcrypt-secret", checkInStationPinEncrypted: "encrypted-secret",
    checkInStationSecretVersion: 7, createdAt: new Date("2034-01-01T00:00:00Z"),
    rsvps: [{ checkInToken: "ticket-secret" }],
  } as Event & { rsvps: Array<{ checkInToken: string }> };
}

describe("eventForView", () => {
  it("keeps the configuration fields that page renderers read", () => {
    const view = eventForView(teamEvent()) as Record<string, unknown>;
    expect(view).toMatchObject({
      registrationMode: "TEAM", teamMinSize: 2, teamMaxSize: 4, soloPolicy: "TEAMS_ONLY", teamTicketMode: "PER_TEAM",
      currency: "INR", refundPolicyKind: "PERCENT_UNTIL", refundPolicyHours: 48, refundPolicyPercent: 50,
      refundPolicyText: "Half back", allowTransfers: true, transferCutoffHours: 12,
      submissionsEnabled: true, judgingStatus: "OPEN", submissionFeeMinor: BigInt(500),
      submissionFeeRefundOnDisqualify: false, capacity: 40, timezone: "UTC",
    });
    expect(view.resultsPublishedAt).toEqual(new Date("2035-01-02T00:00:00Z"));
  });

  it("loses nothing on the way to the dashboard's browser DTO", () => {
    const event = teamEvent();
    expect(toEventClientDto(eventForView(event))).toEqual(toEventClientDto(event));
  });

  it("drops station secrets, unlisted settings and unlisted relations", () => {
    const view = eventForView(teamEvent());
    expect(() => assertSafeView(view)).not.toThrow();
    const serialized = JSON.stringify(view, (_key, value) => (typeof value === "bigint" ? String(value) : value));
    for (const hidden of ["bcrypt-secret", "encrypted-secret", "ticket-secret", "checkInStation", "budgetMinor",
      "participantClaim", "ticketDesignId", "emailEntrantsOnResults", "reviewsPerProject", "resultsAnnouncedAt", "currentJudgingRoundId"]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});
