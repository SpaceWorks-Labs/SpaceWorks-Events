import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  transaction: vi.fn(),
  updateMany: vi.fn(),
  rsvpFindUnique: vi.fn(),
  rsvpFindFirst: vi.fn(),
  rsvpFindMany: vi.fn(),
  checkInEventCreate: vi.fn(),
  orgFindUnique: vi.fn(),
  eventFindFirst: vi.fn(),
  auth: vi.fn(),
}));

vi.mock("@/lib/ticketCheckInEvents", () => ({ publishTicketCheckedIn: mocks.publish }));
vi.mock("@/lib/db", () => ({ prisma: {
  $transaction: mocks.transaction,
  organisation: { findUnique: mocks.orgFindUnique },
  event: { findFirst: mocks.eventFindFirst },
  rSVP: { findFirst: mocks.rsvpFindFirst, findUnique: mocks.rsvpFindUnique, findMany: mocks.rsvpFindMany },
  checkInEvent: { create: mocks.checkInEventCreate },
} }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/eventAccess", () => ({ canAccessEvent: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/rateLimit", () => ({ getClientIpFromHeaders: () => "203.0.113.9", checkRateLimitById: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/checkInStation", () => ({
  CHECK_IN_STATION_COOKIE: "station-proof",
  createCheckInStationProof: () => "proof",
  hasValidCheckInStationProof: () => true,
  stationExpiresAt: () => new Date("2035-01-01T13:00:00.000Z"),
  verifyStationPin: vi.fn().mockResolvedValue(true),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "proof" }) }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { commitCheckInProjection } from "@/lib/checkInMutations";
import { checkInByRsvpId, checkInByToken, syncOfflineCheckIns } from "@/app/actions/checkin";
import { POST as stationPost } from "@/app/api/check-in/station/route";

const event = {
  id: "event_1",
  title: "Event",
  slug: "event",
  organisationId: "org_1",
  startDateTime: new Date(Date.now() - 60 * 60_000),
  endDateTime: new Date(Date.now() + 60 * 60_000),
  checkInStationPinHash: "hash",
  checkInStationSecretVersion: 2,
  organisation: { slug: "org", name: "Org", logoUrl: null },
};

const rsvp = {
  id: "rsvp_1",
  eventId: "event_1",
  eventInstanceId: null,
  status: "CONFIRMED",
  checkedInAt: null as Date | null,
  checkInToken: "opaque-token-123",
  guestName: "Guest",
  guestEmail: "guest@example.test",
  user: null,
  answers: [],
  event: { id: "event_1", organisationId: "org_1", slug: "event" },
  eventInstance: null,
};

/** A transaction that commits an actual transition (count 1) or not (count 0). */
function transition(changed: boolean, current: { checkedInAt: Date | null; status: string } = { checkedInAt: new Date(), status: "CONFIRMED" }) {
  mocks.updateMany.mockResolvedValue({ count: changed ? 1 : 0 });
  mocks.rsvpFindUnique.mockResolvedValue(current);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.orgFindUnique.mockResolvedValue({ id: "org_1", slug: "org" });
  mocks.eventFindFirst.mockResolvedValue(event);
  mocks.rsvpFindFirst.mockResolvedValue(rsvp);
  mocks.rsvpFindMany.mockResolvedValue([{ id: rsvp.id, status: "CONFIRMED", checkedInAt: null }]);
  mocks.checkInEventCreate.mockResolvedValue({ id: "history_1" });
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    rSVP: { updateMany: mocks.updateMany, findUnique: mocks.rsvpFindUnique },
    checkInEvent: { create: mocks.checkInEventCreate },
    // Offline sync: a fresh claim of the mutation id, the row lock, and the stored outcome.
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    offlineCheckInMutation: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
  }));
});

describe("commitCheckInProjection publishing", () => {
  const params = { rsvpId: "rsvp_1", actorUserId: null, source: "online" as const, checkedInAt: new Date("2035-01-01T10:00:00.000Z"), force: false };

  it("publishes after the transaction commits a real transition", async () => {
    transition(true);
    mocks.publish.mockImplementation(() => {
      expect(mocks.checkInEventCreate).toHaveBeenCalled();
    });
    await expect(commitCheckInProjection(params)).resolves.toEqual({ state: "checked-in", checkedInAt: params.checkedInAt });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ rsvpId: "rsvp_1", checkedInAt: params.checkedInAt });
  });

  it("does not publish for already-checked-in, ineligible, or missing RSVPs", async () => {
    transition(false, { checkedInAt: new Date(), status: "CONFIRMED" });
    expect((await commitCheckInProjection(params)).state).toBe("already-checked-in");
    transition(false, { checkedInAt: null, status: "REJECTED" });
    expect((await commitCheckInProjection(params)).state).toBe("ineligible");
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.rsvpFindUnique.mockResolvedValue(null);
    expect((await commitCheckInProjection(params)).state).toBe("missing");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("does not publish when the transaction rolls back", async () => {
    transition(true);
    mocks.checkInEventCreate.mockRejectedValue(new Error("write failed"));
    await expect(commitCheckInProjection(params)).rejects.toThrow("write failed");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe("check-in paths publish only on transition", () => {
  it("online scan by ticket token", async () => {
    transition(true);
    const result = await checkInByToken({ organisationSlug: "org", eventId: "event_1", rawInput: "opaque-token-123" });
    expect(result.ok).toBe(true);
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ rsvpId: "rsvp_1", checkedInAt: expect.any(Date) });

    mocks.publish.mockClear();
    transition(false);
    await checkInByToken({ organisationSlug: "org", eventId: "event_1", rawInput: "opaque-token-123" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("manual check-in by RSVP id", async () => {
    transition(true);
    expect((await checkInByRsvpId({ organisationSlug: "org", eventId: "event_1", rsvpId: "rsvp_1" })).ok).toBe(true);
    expect(mocks.publish).toHaveBeenCalledTimes(1);

    mocks.publish.mockClear();
    mocks.rsvpFindFirst.mockResolvedValue({ ...rsvp, checkedInAt: new Date() });
    await checkInByRsvpId({ organisationSlug: "org", eventId: "event_1", rsvpId: "rsvp_1" });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("offline sync replay", async () => {
    const checkedInAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const input = { organisationSlug: "org", eventId: "event_1", checkIns: [{ rsvpId: "rsvp_1", clientMutationId: "mutation-1", checkedInAt }] };
    transition(true, { checkedInAt: null, status: "CONFIRMED" });
    const result = await syncOfflineCheckIns(input);
    expect(result).toMatchObject({ ok: true, data: { syncedIds: ["rsvp_1"] } });
    expect(mocks.publish).toHaveBeenCalledExactlyOnceWith({ rsvpId: "rsvp_1", checkedInAt: new Date(checkedInAt) });

    mocks.publish.mockClear();
    transition(false);
    expect(await syncOfflineCheckIns(input)).toMatchObject({ ok: true, data: { alreadyCheckedInIds: ["rsvp_1"] } });
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("venue check-in station", async () => {
    const request = () => new Request("https://events.example.test/api/check-in/station", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organisationSlug: "org", eventSlug: "event", action: "checkInRsvp", rsvpId: "rsvp_1" }),
    });
    transition(true);
    expect((await stationPost(request())).status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledTimes(1);

    mocks.publish.mockClear();
    transition(false);
    await stationPost(request());
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
