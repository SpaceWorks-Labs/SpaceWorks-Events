import { AdmissionStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { applicationWebhookEventId, drainApplicationEvents } from "@/lib/admission/statusEvents";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { apply, createAdmissionEvent, decide, paid, setUpAdmission, tearDownAdmission } from "./helpers/admission";

/*
 * application.status_changed is crash-safe (docs/ADMISSION.md "Webhook and
 * API"): a recorded change is marked sent only in the transaction that
 * inserts its deliveries, so a crash after marking leaves it for the next
 * pass, and its event id is derived from the row, so a retry never queues it
 * twice.
 */

let endpointId = "";

/** Every database write after the claim fails, as if the process died there: no delivery insert, no release. */
async function crashAfterClaim() {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "g3_test_crash"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated crash'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "g3_test_crash_delivery" BEFORE INSERT ON "WebhookDelivery" FOR EACH ROW WHEN (NEW."eventType" = 'application.status_changed') EXECUTE FUNCTION "g3_test_crash"()`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "g3_test_crash_release" BEFORE UPDATE ON "AdmissionStatusEvent" FOR EACH ROW WHEN (OLD."emittedAt" IS NOT NULL AND NEW."emittedAt" IS NULL) EXECUTE FUNCTION "g3_test_crash"()`);
}

async function recover() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "g3_test_crash_delivery" ON "WebhookDelivery"`);
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "g3_test_crash_release" ON "AdmissionStatusEvent"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "g3_test_crash"()`);
}

async function deliveriesFor(applicationId: string, status: AdmissionStatus) {
  const rows = await prisma.webhookDelivery.findMany({ where: { endpointId, eventType: "application.status_changed" }, select: { eventId: true, payload: true } });
  return rows.filter((row) => {
    const application = (row.payload as { data: { application: { id: string; status: string } } }).data.application;
    return application.id === applicationId && application.status === status;
  });
}

beforeAll(async () => {
  await setUpAdmission("Application webhooks");
  endpointId = (await prisma.webhookEndpoint.create({ data: { organisationId: paid.organisationId, url: "https://example.org/hook", eventTypes: ["application.status_changed"], secretEncrypted: "x" } })).id;
});
afterAll(async () => {
  await recover();
  await tearDownAdmission();
});

describe.sequential("application status webhooks", () => {
  it("re-sends a change whose drain crashed after marking it, once, with the row's event id", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const a = await apply(event, "crash");
    await flushWebhookEmits();
    await drainApplicationEvents();

    await crashAfterClaim();
    try {
      // The release's own drain (and the background ones) crash after claiming the OFFERED change.
      await decide(ctx, [a.application.id], "ACCEPT");
      await flushWebhookEmits();
      expect(await drainApplicationEvents()).toBe(0);
    } finally {
      await recover();
    }
    const offered = await prisma.admissionStatusEvent.findFirstOrThrow({ where: { applicationId: a.application.id, status: AdmissionStatus.OFFERED } });
    expect(offered.emittedAt).toBeNull();
    expect(await deliveriesFor(a.application.id, AdmissionStatus.OFFERED)).toHaveLength(0);

    // A later pass sends it; further passes send nothing more.
    expect(await drainApplicationEvents()).toBeGreaterThanOrEqual(1);
    await drainApplicationEvents();
    const sent = await deliveriesFor(a.application.id, AdmissionStatus.OFFERED);
    expect(sent).toEqual([expect.objectContaining({ eventId: applicationWebhookEventId(offered.id) })]);
    expect(await prisma.admissionStatusEvent.findUniqueOrThrow({ where: { id: offered.id } })).toMatchObject({ emittedAt: expect.any(Date) });
  });

  it("never queues one change twice, even when two drains retry it at once", async () => {
    const { event, ctx } = await createAdmissionEvent();
    const b = await apply(event, "retry");
    await decide(ctx, [b.application.id], "WAITLIST");
    await flushWebhookEmits();
    const waitlisted = await prisma.admissionStatusEvent.findFirstOrThrow({ where: { applicationId: b.application.id, status: AdmissionStatus.WAITLISTED } });
    expect(await deliveriesFor(b.application.id, AdmissionStatus.WAITLISTED)).toHaveLength(1);

    // Even a row sent again (as an older release could leave it) reuses its event id.
    await prisma.admissionStatusEvent.update({ where: { id: waitlisted.id }, data: { emittedAt: null } });
    await Promise.all([drainApplicationEvents(), drainApplicationEvents()]);
    expect(await deliveriesFor(b.application.id, AdmissionStatus.WAITLISTED)).toEqual([expect.objectContaining({ eventId: applicationWebhookEventId(waitlisted.id) })]);
  });
});
