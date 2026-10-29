import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/*
 * Database triggers stamp timestamp(3) columns. CURRENT_TIMESTAMP is converted
 * with the session TimeZone on assignment, so a session in Asia/Kolkata wrote
 * times 5h30 ahead. Each test runs its writes in a transaction whose session
 * TimeZone is Asia/Kolkata and checks the stored value is UTC.
 */

import { prisma } from "@/lib/db";

const suffix = randomUUID().replace(/-/g, "");
let organisationId = "";
let eventId = "";

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
async function inKolkata<T>(work: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Kolkata'");
    return work(tx);
  });
}

function expectNow(value: Date | null | undefined) {
  expect(value).toBeInstanceOf(Date);
  expect(Math.abs(value!.getTime() - Date.now())).toBeLessThan(60_000);
}

beforeAll(async () => {
  organisationId = (await prisma.organisation.create({ data: { name: "Trigger zone org", slug: `trigger-tz-${suffix}` } })).id;
  eventId = (
    await prisma.event.create({
      data: {
        organisationId,
        title: "Trigger zone night",
        slug: `trigger-tz-${suffix}`,
        startDateTime: new Date("2031-01-01T12:00:00.000Z"),
        endDateTime: new Date("2031-01-01T15:00:00.000Z"),
        timezone: "Asia/Kolkata",
        status: EventStatus.PUBLISHED,
        privacyType: EventPrivacyType.PUBLIC,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.$disconnect();
});

describe("trigger timestamps on a non-UTC session", () => {
  it("dates joining and leaving the waitlist in UTC", async () => {
    const email = `waitlist-tz-${suffix}@example.com`;
    const joined = await inKolkata(async (tx) => {
      expect((await tx.$queryRaw<Array<{ TimeZone: string }>>`SHOW timezone`)[0]!.TimeZone).toBe("Asia/Kolkata");
      return tx.rSVP.create({ data: { eventId, guestEmail: email, guestName: email, attendeeKey: `guest:${email}`, status: RsvpStatus.WAITLISTED } });
    });
    expectNow(joined.waitlistedAt);
    const promoted = await inKolkata((tx) => tx.rSVP.update({ where: { id: joined.id }, data: { status: RsvpStatus.CONFIRMED } }));
    expectNow(promoted.promotedAt);
  });

  it("writes the security audit fallback row in UTC", async () => {
    const renamed = `Trigger zone org ${suffix}`;
    await inKolkata((tx) => tx.organisation.update({ where: { id: organisationId }, data: { name: renamed } }));
    const audit = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "DB_ORGANISATION_UPDATE", targetId: organisationId },
      orderBy: { createdAt: "desc" },
    });
    expectNow(audit.createdAt);
  });

  it("writes the machine API audit fallback row in UTC", async () => {
    const client = await inKolkata((tx) => tx.apiClient.create({ data: { organisationId, name: `Zone client ${suffix}` } }));
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { action: "DB_APICLIENT_INSERT", targetId: client.id } });
    expectNow(audit.createdAt);
  });
});
