import { randomUUID } from "node:crypto";
import { MembershipRole, Prisma, WebhookDeliveryStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Prisma keeps DateTime columns as UTC wall-clock `timestamp(3)`. Raw SQL that
 * passes a JS Date (sent as timestamptz) or uses now() is converted with the
 * session TimeZone, so on a database whose TimeZone is not UTC it wrote and
 * compared shifted times. These tests run the raw-SQL paths with the database
 * TimeZone set to Asia/Kolkata (UTC+5:30), the initdb default on many hosts.
 */

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { sqlUtcTimestamp, SQL_UTC_NOW } from "@/lib/sqlTimestamp";
import { deliverWebhookBatch } from "@/lib/webhooks/delivery";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { loadAccountRegistrationRecords } from "@/lib/accountRegistrations";

const suffix = randomUUID().replace(/-/g, "");
let databaseName = "";
let orgId = "";
let userId = "";

async function setDatabaseTimeZone(zone: string | null) {
  // Identifiers can't be parameters; the name comes from current_database().
  const quoted = `"${databaseName.replace(/"/g, '""')}"`;
  await prisma.$executeRawUnsafe(zone ? `ALTER DATABASE ${quoted} SET timezone TO '${zone}'` : `ALTER DATABASE ${quoted} RESET timezone`);
  // New sessions pick the setting up; drop the pooled ones.
  await prisma.$disconnect();
}

beforeAll(async () => {
  databaseName = (await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS "name"`)[0]!.name;
  await setDatabaseTimeZone("Asia/Kolkata");
  expect((await prisma.$queryRaw<Array<{ TimeZone: string }>>`SHOW timezone`)[0]!.TimeZone).toBe("Asia/Kolkata");
  orgId = (await prisma.organisation.create({ data: { name: "Timezone org", slug: `tz-${suffix}` } })).id;
  userId = (await prisma.user.create({ data: { email: `tz-user-${suffix}@example.test`, emailVerified: new Date() } })).id;
  await prisma.membership.create({ data: { userId, organisationId: orgId, role: MembershipRole.OWNER } });
});

afterAll(async () => {
  await flushWebhookEmits().catch(() => undefined);
  await prisma.organisation.deleteMany({ where: { id: orgId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await setDatabaseTimeZone(null);
});

describe("raw SQL timestamps on a non-UTC database", () => {
  it("writes and compares the helpers' values as UTC wall-clock time", async () => {
    const at = new Date("2031-03-04T05:06:07.089Z");
    const [row] = await prisma.$queryRaw<Array<{ at: Date; now: Date; matches: boolean }>>`
      SELECT ${sqlUtcTimestamp(at)} AS "at", ${SQL_UTC_NOW} AS "now",
             ${sqlUtcTimestamp(at)} = ${Prisma.sql`'2031-03-04 05:06:07.089'::timestamp(3)`} AS "matches"`;
    expect(row!.at.toISOString()).toBe(at.toISOString());
    expect(row!.matches).toBe(true);
    expect(Math.abs(row!.now.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("does not claim a webhook delivery before its retry time", async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: { organisationId: orgId, url: "https://hooks.example.test/tz", eventTypes: ["event.published"], secretEncrypted: "unused" },
    });
    const notYet = new Date(Date.now() + 2 * 60 * 60_000);
    const delivery = await prisma.webhookDelivery.create({
      data: { endpointId: endpoint.id, organisationId: orgId, eventId: `evt_tz_${suffix}`, eventType: "event.published", payload: {}, nextAttemptAt: notYet },
    });
    await deliverWebhookBatch(100);
    const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(after).toMatchObject({ status: WebhookDeliveryStatus.PENDING, attempts: 0, lockedAt: null });
  });

  it("files a registration under Past as soon as its event has ended", async () => {
    const event = await prisma.event.create({
      data: {
        organisationId: orgId,
        title: "Ended an hour ago",
        slug: `tz-ended-${suffix}`,
        startDateTime: new Date(Date.now() - 3 * 60 * 60_000),
        endDateTime: new Date(Date.now() - 60 * 60_000),
        timezone: "UTC",
        status: "PUBLISHED",
      },
    });
    await prisma.rSVP.create({ data: { eventId: event.id, userId, attendeeKey: `user:${userId}`, status: "CONFIRMED" } });
    // A shifted comparison (5.5 hours) would still list it under Upcoming.
    const records = await loadAccountRegistrationRecords(userId);
    expect(JSON.stringify(records.past)).toContain("Ended an hour ago");
    expect(JSON.stringify(records.upcoming)).not.toContain("Ended an hour ago");
  });
});
