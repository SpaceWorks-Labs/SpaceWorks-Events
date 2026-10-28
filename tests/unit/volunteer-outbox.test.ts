import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ member: vi.fn(), signup: vi.fn(), certificates: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { eventCrewMember: { findUnique: mocks.member }, volunteerShiftSignup: { findFirst: mocks.signup }, contributorCertificate: { count: mocks.certificates } } }));
vi.mock("@/lib/email/volunteer", () => ({ sendVolunteerNoticeEmail: mocks.send }));

import { asVolunteerNoticePayload, deliverVolunteerNotice, VOLUNTEER_NOTICE_KIND } from "@/lib/outbox/volunteer";
import { containsCapability } from "@/lib/outbox/payloads";
import { BULK_OUTBOX_KINDS } from "@/lib/outbox/due";

/* The volunteer-notice outbox kind (docs/VOLUNTEERS.md). */

const base = { to: "crew@example.test", organisationId: "org_1", crewMemberId: "crew_1" };
const member = { name: "Asha", email: "asha.now@example.test", rsvp: { status: "CONFIRMED", checkInToken: "ticket-token" }, event: { organisationId: "org_1", title: "Launch", status: "PUBLISHED", timezone: "UTC" } };
const shift = { title: "Doors", zone: "Hall A", startsAt: new Date("2035-01-01T10:00:00Z"), endsAt: new Date("2035-01-01T12:00:00Z") };

describe("volunteer notice outbox kind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.member.mockResolvedValue(member);
  });

  it("is transactional and deleted after delivery, because it links the crew ticket", () => {
    expect(BULK_OUTBOX_KINDS).not.toContain(VOLUNTEER_NOTICE_KIND);
    expect(containsCapability(VOLUNTEER_NOTICE_KIND, { ...base, notice: "approved" })).toBe(true);
  });

  it("validates the payload strictly: ids, a known notice, and a bounded shift snapshot", () => {
    expect(asVolunteerNoticePayload({ ...base, notice: "approved", signupId: "s_1" })).toMatchObject({ notice: "approved" });
    expect(asVolunteerNoticePayload({ ...base, notice: "paid" })).toBeNull();
    expect(asVolunteerNoticePayload({ ...base, to: "nope", notice: "approved" })).toBeNull();
    expect(asVolunteerNoticePayload({ ...base, notice: "cancelled", shift: { title: "x".repeat(121), zone: "", startsAt: "a", endsAt: "b" } })).toBeNull();
    expect(asVolunteerNoticePayload(null)).toBeNull();
  });

  it("drops an approval that no longer stands, and anything for a removed member or another organisation", async () => {
    mocks.signup.mockResolvedValue({ status: "WITHDRAWN", shift });
    await expect(deliverVolunteerNotice({ ...base, notice: "approved", signupId: "s_1" }, "<id>")).resolves.toBe("dropped");
    mocks.member.mockResolvedValue({ ...member, event: { ...member.event, organisationId: "org_2" } });
    await expect(deliverVolunteerNotice({ ...base, notice: "certificate" }, "<id>")).resolves.toBe("dropped");
    mocks.member.mockResolvedValue(null);
    await expect(deliverVolunteerNotice({ ...base, notice: "cancelled", shift: { ...shift, startsAt: "2035-01-01T10:00:00Z", endsAt: "2035-01-01T12:00:00Z" } }, "<id>")).resolves.toBe("dropped");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends a live approval and a revoked-certificate notice is dropped", async () => {
    mocks.signup.mockResolvedValue({ status: "APPROVED", shift });
    await expect(deliverVolunteerNotice({ ...base, notice: "promoted", signupId: "s_1" }, "<id>")).resolves.toBe("sent");
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({ to: "asha.now@example.test", notice: "promoted", checkInToken: "ticket-token", shift, recipientName: "Asha" }));
    mocks.certificates.mockResolvedValue(0);
    await expect(deliverVolunteerNotice({ ...base, notice: "certificate" }, "<id>")).resolves.toBe("dropped");
  });
});
