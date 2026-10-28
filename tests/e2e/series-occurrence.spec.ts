import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";

const prisma = new PrismaClient();
const suffix = randomUUID().replaceAll("-", "");
const orgSlug = `e2e-series-${suffix}`;
const guestEmail = `series-${suffix}@example.test`;
let organisationId = "";
let instanceId = "";

test.beforeAll(async () => {
  const organisation = await prisma.organisation.create({ data: { name: `E2E Series ${suffix}`, slug: orgSlug } });
  organisationId = organisation.id;
  const start = new Date("2035-02-01T18:00:00.000Z");
  const series = await prisma.eventSeries.create({
    data: {
      organisationId,
      title: `Weekly meetup ${suffix}`,
      slug: `weekly-${suffix}`,
      recurrenceRule: "DTSTART:20350201T180000Z\nRRULE:FREQ=WEEKLY;COUNT=2",
      instanceDurationMs: 3_600_000,
      timezone: "UTC",
      status: EventStatus.PUBLISHED,
      privacyType: EventPrivacyType.PUBLIC,
      instances: { create: [{ startDateTime: start, endDateTime: new Date(start.getTime() + 3_600_000) }] },
    },
    include: { instances: true },
  });
  instanceId = series.instances[0]!.id;
});

test.afterAll(async () => {
  // The ticket email is queued, never sent, by the test server.
  await prisma.$executeRaw`DELETE FROM "OutboxMessage" WHERE "payload"->>'to' = ${guestEmail}`;
  if (organisationId) await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.$disconnect();
});

test("registering on a series occurrence updates its going count without a reload", async ({ page }) => {
  const joinCard = page.locator("section", { has: page.locator("#join-title") });
  await page.goto(`/${orgSlug}/i/${instanceId}`);
  await expect(joinCard.getByText("0 going")).toBeVisible();

  await joinCard.getByLabel("Name").fill("Series Guest");
  await joinCard.getByLabel("Email").fill(guestEmail);
  await joinCard.getByRole("button", { name: "Register" }).click();

  await expect(joinCard.getByRole("status").filter({ hasText: /Registration (confirmed|received)/ })).toBeVisible();
  await expect(joinCard.getByText("1 going")).toBeVisible();
});
