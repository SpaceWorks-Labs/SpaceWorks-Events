import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

process.env.MFA_ENCRYPTION_KEY ||= Buffer.alloc(32, 3).toString("base64");

import { prisma } from "@/lib/db";
import { enqueueWebhookPing } from "@/lib/webhooks/emit";
import { deliverWebhookNow } from "@/lib/webhooks/delivery";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { setWebhookResolverForTests } from "@/lib/webhooks/urlSafety";
import { orgId, orgSlug, received, setUpWebhooks, tearDownWebhooks, type Reply } from "./helpers/webhooks";

// The delivery-time DNS rebinding check, on its own endpoint (webhooks.db.test.ts holds the main journey).
let respondWith: Reply = { status: 200 };

describe.sequential("organisation webhooks", () => {
  beforeAll(() => setUpWebhooks(() => respondWith));

  beforeEach(() => {
    received.length = 0;
    respondWith = { status: 200 };
    process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
  });

  afterEach(() => setWebhookResolverForTests(null));

  afterAll(tearDownWebhooks);

  it("blocks a host that resolves to a private address at delivery time (DNS rebinding)", async () => {
    delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
    setWebhookResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    const rebinding = await prisma.webhookEndpoint.create({
      data: { organisationId: orgId, url: "https://rebind.example.test/hook", eventTypes: ["checkin.created"], secretEncrypted: encryptWebhookSecret("whsec_x") },
    });
    // The name resolved publicly when saved; it now answers with loopback.
    setWebhookResolverForTests(async () => [{ address: "127.0.0.1", family: 4 }]);
    const id = await enqueueWebhookPing({ id: rebinding.id, organisation: { id: orgId, slug: orgSlug } });
    const outcome = await deliverWebhookNow(id);
    expect(outcome).toMatchObject({ ok: false, statusCode: null, error: expect.stringMatching(/^Blocked/) });
    expect(received).toHaveLength(0);
    await prisma.webhookEndpoint.delete({ where: { id: rebinding.id } });
  });
});
