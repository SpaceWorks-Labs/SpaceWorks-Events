import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  canAccess: vi.fn(),
  limited: vi.fn(),
  orgFind: vi.fn(),
  eventFind: vi.fn(),
  typeFind: vi.fn(),
  settingsFind: vi.fn(),
  transaction: vi.fn(),
  paidEnabled: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/eventAccess", () => ({ canAccessEvent: mocks.canAccess }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: mocks.limited }));
vi.mock("@/lib/instanceSettings", () => ({ isPaidEventsEnabled: mocks.paidEnabled }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: {
  organisation: { findUnique: mocks.orgFind },
  event: { findFirst: mocks.eventFind, count: async () => 0 },
  ticketType: { findFirst: mocks.typeFind },
  organisationPaymentSettings: { findUnique: mocks.settingsFind },
  $transaction: mocks.transaction,
} }));

import { saveTicketType } from "@/app/actions/ticket-types";

const input = { organisationSlug: "tenant", eventId: "event_1", name: "General", price: "499" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "user_1" } });
  mocks.limited.mockResolvedValue(false);
  mocks.orgFind.mockResolvedValue({ id: "org_1", slug: "tenant" });
  mocks.eventFind.mockResolvedValue({ id: "event_1", slug: "meetup", privacyType: "PUBLIC", currency: null });
  mocks.paidEnabled.mockResolvedValue(true);
});

describe("ticket type actions", () => {
  it("checks the EDIT_DETAILS event permission for this event, not just organisation membership", async () => {
    mocks.canAccess.mockResolvedValue(false);
    await expect(saveTicketType(input)).resolves.toEqual({ ok: false, error: "You don't have permission to change this event's tickets." });
    expect(mocks.canAccess).toHaveBeenCalledWith({ userId: "user_1", organisationId: "org_1", eventId: "event_1", permission: "EDIT_DETAILS" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("refuses a paid ticket below the connected provider's minimum", async () => {
    mocks.canAccess.mockResolvedValue(true);
    mocks.settingsFind.mockResolvedValue({ organisationId: "org_1", provider: "RAZORPAY", currency: "INR", razorpayKeyId: "rzp_test_x", razorpayKeySecretEncrypted: "v1.a", razorpayWebhookSecretEncrypted: "v1.b", stripeSecretKeyEncrypted: null, stripeWebhookSecretEncrypted: null, stripeTestMode: false });
    await expect(saveTicketType({ ...input, price: "0.50" })).resolves.toEqual({ ok: false, error: "The smallest price Razorpay accepts is ₹1.00." });
  });

  it("refuses paid tickets until a payment account is connected", async () => {
    mocks.canAccess.mockResolvedValue(true);
    mocks.settingsFind.mockResolvedValue(null);
    await expect(saveTicketType(input)).resolves.toEqual({ ok: false, error: "Connect a payment account in Settings → Payments before adding a paid ticket." });
  });
});
