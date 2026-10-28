import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { EventPermission, EventPrivacyType, EventStatus, MembershipRole, WebhookDeliveryStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { deliverWebhookBatch } from "@/lib/webhooks/delivery";

/*
 * Shared receiver, organisations and helpers for the organisation webhook
 * suites. The receiver answers with whatever `reply()` returns, so each test
 * file keeps its own `respondWith` and changes it per test.
 */

export type Received = { path: string; headers: http.IncomingHttpHeaders; body: string };
export type Reply = { status: number; headers?: Record<string, string>; body?: string };

export const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
export const received: Received[] = [];
let server: http.Server;
export let receiverUrl = "";
export let downUrl = "";

export let orgId = "";
export let orgSlug = "";
export let otherOrgId = "";
export let otherOrgSlug = "";
export let ownerId = "";
export let adminId = "";
export let memberId = "";
export let collaboratorId = "";
export let otherAdminId = "";
export let publicEventId = "";
export let publicEventSlug = "";
export let approvalEventId = "";
export let approvalEventSlug = "";

export async function settle() {
  await flushWebhookEmits();
}

export async function deliveriesOf(type: string) {
  return prisma.webhookDelivery.findMany({ where: { organisationId: orgId, eventType: type }, orderBy: { createdAt: "asc" } });
}

export async function deliverAll() {
  // Rows can wait for a retry; pull everything due for this organisation now.
  await prisma.webhookDelivery.updateMany({ where: { organisationId: orgId, status: WebhookDeliveryStatus.PENDING }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  return deliverWebhookBatch(100);
}

/** Starts the receiver and creates both organisations, their staff and the two events. */
export async function setUpWebhooks(reply: () => Reply) {
  process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS = "1";
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      const respondWith = reply();
      response.writeHead(respondWith.status, respondWith.headers ?? { "content-type": "text/plain" });
      response.end(respondWith.body ?? "ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks/spaceworks`;
  // A port that was just released: nothing listens there.
  const probe = http.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  downUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}/down`;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  orgSlug = `hooks-a-${suffix}`;
  otherOrgSlug = `hooks-b-${suffix}`;
  const [org, otherOrg] = await Promise.all([
    prisma.organisation.create({ data: { name: "Hooks A", slug: orgSlug } }),
    prisma.organisation.create({ data: { name: "Hooks B", slug: otherOrgSlug } }),
  ]);
  orgId = org.id;
  otherOrgId = otherOrg.id;
  const users = await Promise.all(
    ["owner", "admin", "member", "collab", "other-admin"].map((label) =>
      prisma.user.create({ data: { name: `Hooks ${label}`, email: `hooks-${label}-${suffix}@example.test`, emailVerified: new Date() } }),
    ),
  );
  [ownerId, adminId, memberId, collaboratorId, otherAdminId] = users.map((user) => user.id) as [string, string, string, string, string];
  await prisma.membership.createMany({
    data: [
      { userId: ownerId, organisationId: orgId, role: MembershipRole.OWNER },
      { userId: adminId, organisationId: orgId, role: MembershipRole.ADMIN },
      { userId: memberId, organisationId: orgId, role: MembershipRole.MEMBER },
      { userId: otherAdminId, organisationId: otherOrgId, role: MembershipRole.ADMIN },
    ],
  });
  publicEventSlug = `public-${suffix}`;
  approvalEventSlug = `approval-${suffix}`;
  const base = { organisationId: orgId, startDateTime: new Date("2031-01-01T10:00:00Z"), endDateTime: new Date("2031-01-01T12:00:00Z"), timezone: "UTC", status: EventStatus.PUBLISHED };
  const publicEvent = await prisma.event.create({ data: { ...base, title: "Hooks public", slug: publicEventSlug, privacyType: EventPrivacyType.PUBLIC, page: { create: { isPublished: true } } } });
  const approvalEvent = await prisma.event.create({ data: { ...base, title: "Hooks approval", slug: approvalEventSlug, privacyType: EventPrivacyType.APPROVAL_REQUIRED, page: { create: { isPublished: true } } } });
  publicEventId = publicEvent.id;
  approvalEventId = approvalEvent.id;
  // A co-organiser holding every grant on an event is still not an organisation admin.
  await prisma.eventCollaborator.create({
    data: { eventId: publicEventId, userId: collaboratorId, permissions: Object.values(EventPermission) },
  });
  await prisma.eventFeedbackForm.create({ data: { eventId: publicEventId, isOpen: true, certificateEnabled: false } });
}

export async function tearDownWebhooks() {
  delete process.env.WEBHOOKS_ALLOW_PRIVATE_TARGETS;
  await flushWebhookEmits();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.organisation.deleteMany({ where: { id: { in: [orgId, otherOrgId].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: `-${suffix}@example.test` } } });
  await prisma.$disconnect();
}
