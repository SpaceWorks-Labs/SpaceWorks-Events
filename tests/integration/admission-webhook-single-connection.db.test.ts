import crypto from "node:crypto";
import { afterAll, expect, it, vi } from "vitest";

// Replace the shared singleton for both the drain and payload builder. A
// separate client used only by the drain would miss accidental global reads.
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const source = process.env.TEST_DATABASE_URL;
  if (!source) throw new Error("TEST_DATABASE_URL is required");
  const url = new URL(source);
  url.searchParams.set("connection_limit", "1");
  return { prisma: new PrismaClient({ datasources: { db: { url: url.toString() } } }) };
});

import { prisma } from "@/lib/db";
import { applicationWebhookEventId, drainApplicationEvents } from "@/lib/admission/statusEvents";

let organisationId: string | undefined;

afterAll(async () => {
  try {
    if (organisationId) await prisma.organisation.delete({ where: { id: organisationId } });
  } finally {
    await prisma.$disconnect();
  }
});

it("drains a subscribed application status event with only one database connection", async () => {
  const organisation = await prisma.organisation.create({
    data: { name: "Single connection webhooks", slug: `single-connection-${crypto.randomUUID()}` },
  });
  organisationId = organisation.id;
  const event = await prisma.event.create({ data: {
    organisationId, title: "Applications", slug: "applications", timezone: "UTC",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"),
    status: "PUBLISHED", privacyType: "APPROVAL_REQUIRED", admissionEnabled: true,
    admissionStages: { create: { position: 1, name: "Review", status: "OPEN" } },
  } });
  const endpoint = await prisma.webhookEndpoint.create({ data: {
    organisationId, url: "https://example.org/hook", secretEncrypted: "unused",
    eventTypes: ["application.status_changed"],
  } });
  const rsvp = await prisma.rSVP.create({ data: {
    eventId: event.id, attendeeKey: "guest:single-connection@example.test",
    guestEmail: "single-connection@example.test", status: "PENDING_APPROVAL",
  } });
  const application = await prisma.admissionApplication.findUniqueOrThrow({ where: { rsvpId: rsvp.id } });
  // The real trigger records the transition; no action starts a background drain.
  await prisma.admissionApplication.update({ where: { id: application.id }, data: { status: "WAITLISTED", queuedAt: new Date() } });
  const change = await prisma.admissionStatusEvent.findFirstOrThrow({ where: { applicationId: application.id } });
  expect(change.emittedAt).toBeNull();
  expect(change.stageId).toBe(application.currentStageId);
  expect(change.stageId).not.toBeNull();

  expect(await drainApplicationEvents()).toBeGreaterThanOrEqual(1);
  expect(await prisma.admissionStatusEvent.findUniqueOrThrow({ where: { id: change.id } }))
    .toMatchObject({ emittedAt: expect.any(Date) });
  const deliveries = await prisma.webhookDelivery.findMany({ where: {
    endpointId: endpoint.id, eventId: applicationWebhookEventId(change.id),
  } });
  expect(deliveries).toHaveLength(1);
  expect(deliveries[0].payload).toMatchObject({
    type: "application.status_changed",
    data: { application: { id: application.id, status: "WAITLISTED", stage: { id: change.stageId, name: "Review" } }, previousStatus: "IN_REVIEW" },
  });
  await drainApplicationEvents();
  expect(await prisma.webhookDelivery.count({ where: { endpointId: endpoint.id } })).toBe(1);
});
