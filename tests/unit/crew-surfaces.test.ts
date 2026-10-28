import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import robots from "@/app/robots";
import { isNoStorePage } from "@/lib/pageSecurity";
import { RESERVED_ORGANISATION_SLUGS } from "@/lib/slug";
import { doorExtras, getCheckInDetails } from "@/lib/checkInDetails";
import { BADGE_STATUS_FILTERS, isBadgeStatusFilter } from "@/lib/badge/filters";
import { badgeAttendeeFor, badgeStatusWhere } from "@/lib/badge/data";
import { managedImageUrl } from "@/lib/badge/imageUrl";
import { sectionNote, SECTION_TYPES } from "@/components/event-dashboard/event-page/summary";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("crew sign-up link route (docs/CREW.md)", () => {
  it("is never stored, never crawled, and its slug is reserved", () => {
    expect(isNoStorePage("/crew/abcDEF_123-xyz")).toBe(true);
    expect(isNoStorePage("/crew/abc/")).toBe(true);
    const rules = robots().rules;
    expect((Array.isArray(rules) ? rules[0] : rules)?.disallow).toContain("/crew/");
    expect(RESERVED_ORGANISATION_SLUGS.has("crew")).toBe(true);
  });
});

describe("crew at the check-in desk", () => {
  it("adds the crew food preference after the door answers, and flags the ticket", () => {
    expect(getCheckInDetails([], { foodPreference: " Vegan " })).toEqual([{ label: "Crew food preference", value: "Vegan" }]);
    expect(getCheckInDetails([], { foodPreference: "  " })).toEqual([]);
    expect(getCheckInDetails([], null)).toEqual([]);
    expect(doorExtras({ team: { name: "Owls" }, isCrew: false })).toEqual({ teamName: "Owls", isCrew: false });
    expect(doorExtras({ isCrew: true })).toEqual({ teamName: null, isCrew: true });
  });
});

describe("crew ID badges", () => {
  const base = { id: "rsvp_1", guestName: "Asha", guestEmail: "asha@example.test", checkInToken: "tok", answers: [], team: null, user: null };

  it("offers crew and attendee filters", () => {
    expect(BADGE_STATUS_FILTERS).toEqual(expect.arrayContaining(["crew", "attendees"]));
    expect(isBadgeStatusFilter("crew")).toBe(true);
    expect(badgeStatusWhere("crew")).toEqual({ isCrew: true });
    expect(badgeStatusWhere("attendees")).toEqual({ status: "CONFIRMED", isCrew: false });
  });

  it("prints the crew role in the team slot and only this organisation's crew photo", () => {
    const own = `/api/uploads/organisations/org_1/event-crew/${uuid}.webp`;
    const crew = { ...base, isCrew: true, crewMember: { role: "Stage lead", photoUrl: own, foodPreference: "Jain" } };
    const badge = badgeAttendeeFor(crew as never, "org_1");
    expect(badge.teamName).toBe("Crew · Stage lead");
    expect(badge.photoUrl).toBe(own);
    expect(badge.checkInDetails).toEqual([{ label: "Crew food preference", value: "Jain" }]);
    expect(badgeAttendeeFor(crew as never, "org_other").photoUrl).toBeNull();
    const remote = { ...crew, crewMember: { ...crew.crewMember, role: "", photoUrl: "https://evil.example/p.webp" } };
    expect(badgeAttendeeFor(remote as never, "org_1")).toMatchObject({ teamName: "Crew", photoUrl: null });
    expect(managedImageUrl(own, { kind: "organisation", organisationId: "org_1", category: "event-sponsors" })).toBeNull();
    expect(badgeAttendeeFor({ ...base, isCrew: false, crewMember: null } as never, "org_1").teamName).toBeNull();
  });
});

describe("Crew page section", () => {
  it("is a known section with a note from the shown crew count", () => {
    expect(SECTION_TYPES).toContain("CREW");
    const data = { highlights: [], speakers: [], sponsors: [], resources: [], faqs: [], sessionCount: 0, location: "", isOnline: false };
    expect(sectionNote("CREW", { ...data, crewShown: 3 })).toBe("3 crew shown");
    expect(sectionNote("CREW", data)).toBe("No crew shown yet");
  });
});
