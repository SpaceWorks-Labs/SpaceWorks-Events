import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ load: vi.fn(), fields: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/eventDashboard/context", () => ({ loadEventDashboard: mocks.load }));
vi.mock("@/lib/eventDashboard/data", () => ({ loadRegistrationFields: mocks.fields }));
vi.mock("@/lib/eventDashboard/teams", () => ({ loadRegistrationLock: mocks.lock }));
vi.mock("@/components/event/EventWebsiteManager", () => ({}));
import { loadEventPagePanel } from "@/lib/views/components__event-dashboard__panels__EventPagePanel";

function context(canEditEventDetails: boolean) {
  return {
    organisation: { id: "org_1", slug: "org", name: "Org" },
    event: {
      id: "event_1", title: "Hack", slug: "hack", timezone: "UTC", privacyType: "PUBLIC", isOnline: false, location: "Venue",
      startDateTime: new Date("2035-01-01T10:00:00Z"), page: null, highlights: [], speakers: [], sponsors: [], resources: [], faqs: [], sessions: [],
      registrationMode: "TEAM",
    },
    permissions: { canEditEventDetails, canManageSchedule: false },
    now: new Date("2034-12-01T00:00:00Z"),
  };
}

beforeEach(() => {
  mocks.fields.mockReset().mockResolvedValue([]);
  mocks.lock.mockReset().mockResolvedValue({ total: 3, largestTeam: 2 });
});

describe("event page panel registration lock", () => {
  it("passes the registration lock to an editor, so Details shows the team switch locked", async () => {
    const ctx = context(true);
    mocks.load.mockResolvedValue(ctx);
    const result = await loadEventPagePanel({ ctx: ctx as never });
    expect(mocks.lock).toHaveBeenCalledWith("event_1");
    expect(result.registrations).toEqual({ total: 3, largestTeam: 2 });
  });

  it("does not count registrations for someone who cannot edit the details", async () => {
    const ctx = context(false);
    mocks.load.mockResolvedValue(ctx);
    const result = await loadEventPagePanel({ ctx: ctx as never });
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(result.registrations).toBeUndefined();
  });
});
