import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rsvp: vi.fn(), team: vi.fn(), check: vi.fn(), link: vi.fn(), member: vi.fn(), signup: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {
  rSVP: { findUnique: mocks.rsvp }, team: { findUnique: mocks.team }, attendanceCheck: { findUnique: mocks.check },
  submissionLink: { findUnique: mocks.link }, eventCrewMember: { findUnique: mocks.member }, volunteerShiftSignup: { findFirst: mocks.signup },
} }));
vi.mock("@/lib/email", () => ({ sendTeamCreatedEmail: mocks.send, sendTeamMemberAddedEmail: mocks.send, sendSubmissionLinkEmail: mocks.send }));
vi.mock("@/lib/email/attendance", () => ({ sendAttendanceCheckEmail: mocks.send }));
vi.mock("@/lib/email/crew", () => ({ sendCrewTicketEmail: mocks.send }));
vi.mock("@/lib/email/volunteer", () => ({ sendVolunteerNoticeEmail: mocks.send }));
vi.mock("@/lib/core/attendanceCheck/eligible", () => ({ isEligibleRsvp: async () => true }));

vi.mock("@/lib/core/attendanceCheck/release", () => ({ releaseFor: async () => null }));
vi.mock("@/lib/ticketDesign/resolve", () => ({ designedTicketAttachment: async () => undefined }));

import { isCurrentHolderRecipient } from "@/lib/outbox/holder";
import { deliverTeamMessage } from "@/lib/outbox/team";
import { deliverJudgingMessage } from "@/lib/outbox/judging";
import { deliverAttendanceCheck } from "@/lib/outbox/attendance";
import { deliverCrewMessage } from "@/lib/outbox/crew";
import { deliverVolunteerNotice } from "@/lib/outbox/volunteer";
import { hashTeamManageToken } from "@/lib/teamToken";
import { hashSubmissionLinkToken } from "@/lib/submissionToken";
import { hashAttendanceToken } from "@/lib/attendanceToken";

const token = "a".repeat(43);
const holder = { guestName: "New holder", guestEmail: "new@example.test", user: null };
const payload = { to: "old@example.test", rsvpId: "rsvp_1", token };
const event = { title: "Launch", status: "PUBLISHED", organisationId: "org_1", slug: "launch", organisation: { slug: "org", name: "Organisation" }, startDateTime: new Date(Date.now() + 86400000) };

describe("capability email recipient ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalises the current address, gives the account email precedence and refuses missing addresses", () => {
    expect(isCurrentHolderRecipient(holder, " NEW@EXAMPLE.TEST ")).toBe(true);
    expect(isCurrentHolderRecipient({ ...holder, user: { email: "account@example.test" } }, holder.guestEmail)).toBe(false);
    expect(isCurrentHolderRecipient(null, payload.to)).toBe(false);
    expect(isCurrentHolderRecipient({ guestEmail: null, user: null }, payload.to)).toBe(false);
  });

  it.each(["team-created", "team-member-added", "submission-link", "attendance-check", "crew-ticket", "volunteer-notice"])("drops a %s addressed to a different holder even when its capability still matches", async (kind) => {
    const rsvp = { ...holder, status: "CONFIRMED", isCrew: true, event, team: { name: "Team" }, crewMember: { name: "Crew", role: "Doors" } };
    mocks.rsvp.mockResolvedValue(rsvp);
    mocks.team.mockResolvedValue({ name: "Team", manageTokenHash: hashTeamManageToken(token), leaderRsvp: holder, event });
    mocks.link.mockResolvedValue({ tokenHash: hashSubmissionLinkToken(token), rsvp: { ...rsvp, teamId: null } });
    mocks.check.mockResolvedValue({ tokenHash: hashAttendanceToken(token), response: null, eventId: "event_1", rsvp, event });
    mocks.signup.mockResolvedValue({ status: "APPROVED", shift: { title: "Doors", zone: "Hall", startsAt: new Date(), endsAt: new Date() } });
    mocks.member.mockResolvedValue({ name: "Crew", email: holder.guestEmail, rsvp, event });
    const result = kind === "team-created" ? await deliverTeamMessage(kind, { to: payload.to, teamId: "team_1", manageToken: token }, "<m>")
      : kind === "team-member-added" ? await deliverTeamMessage(kind, { to: payload.to, checkInToken: token }, "<m>")
      : kind === "submission-link" ? await deliverJudgingMessage(kind, payload, "<m>")
      : kind === "attendance-check" ? await deliverAttendanceCheck(payload, "<m>")
      : kind === "crew-ticket" ? await deliverCrewMessage({ to: payload.to, checkInToken: token, organisationId: "org_1" }, "<m>")
      : await deliverVolunteerNotice({ to: payload.to, organisationId: "org_1", notice: "approved", crewMemberId: "crew_1", signupId: "signup_1" }, "<m>");
    expect(result).toBe("dropped");
    expect(mocks.send.mock.calls.length).toBe(0);
  });
});
