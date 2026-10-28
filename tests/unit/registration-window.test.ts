import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/permissions", () => ({ canPublishEvents: vi.fn(), getMembership: vi.fn() }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: vi.fn() }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { manualCloseCutoff, registrationWindowState } from "@/lib/core/registrationWindow";

const now = new Date("2030-05-10T18:00:00Z");
const base = {
  status: "PUBLISHED" as const,
  startDateTime: new Date("2030-05-10T17:00:00Z"),
  endDateTime: new Date("2030-05-10T21:00:00Z"),
  registrationClosesAt: null,
  registrationLeadMinutes: null,
};

describe("mobile registration window", () => {
  it("never pins a manual close after the event start", () => {
    expect(manualCloseCutoff(base.startDateTime, now)).toEqual(base.startDateTime);
    const early = new Date("2030-05-09T12:00:00Z");
    expect(manualCloseCutoff(base.startDateTime, early)).toEqual(early);
  });

  it("reports state, reason and whether the close can be undone", () => {
    expect(registrationWindowState(base, now)).toEqual({ registrationOpen: true, registrationClosesAt: null, registrationClosedReason: null, registrationManuallyClosed: false });
    expect(registrationWindowState({ ...base, registrationClosesAt: base.startDateTime, registrationManuallyClosedAt: now }, now)).toEqual({
      registrationOpen: false, registrationClosesAt: base.startDateTime.toISOString(), registrationClosedReason: "Registration has closed.", registrationManuallyClosed: true,
    });
    // A restored lead time that has already passed stays closed, with the reason.
    expect(registrationWindowState({ ...base, registrationLeadMinutes: 120 }, now)).toMatchObject({ registrationOpen: false, registrationClosedReason: "Registration has closed." });
    expect(registrationWindowState({ ...base, endDateTime: now }, now).registrationClosedReason).toBe("This event has ended.");
  });
});
