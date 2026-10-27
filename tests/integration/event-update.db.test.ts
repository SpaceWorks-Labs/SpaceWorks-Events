import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventPrivacyType, EventStatus, MembershipRole } from "@prisma/client";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, updateTag: () => undefined }));

import { updateEvent } from "@/app/actions/event";
import { prisma } from "@/lib/db";

const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const organisationSlug = `event-update-${suffix}`;
let organisationId = "";
let userId = "";
let eventId = "";
// Started 30 minutes ago (minute precision, as the dashboard form submits it), ends in two hours.
const start = new Date(Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000);
const end = new Date(start.getTime() + 150 * 60_000);

const input = (overrides: Record<string, unknown> = {}) => ({
  organisationSlug,
  eventId,
  title: "Doors are open",
  tags: "",
  coverImageUrl: "",
  startDateTime: start.toISOString(),
  endDateTime: end.toISOString(),
  timezone: "UTC",
  location: "Main hall",
  mapLinkUrl: "",
  isOnline: false,
  capacity: "",
  registrationClosesAt: "",
  registrationLeadMinutes: "",
  status: EventStatus.PUBLISHED,
  privacyType: EventPrivacyType.PUBLIC,
  listedPublicly: false,
  ...overrides,
});

describe.sequential("updating an event that has already started", { timeout: 30_000 }, () => {
  beforeAll(async () => {
    const user = await prisma.user.create({ data: { name: "Owner", email: `event-update-${suffix}@example.test`, emailVerified: new Date() } });
    userId = user.id;
    const organisation = await prisma.organisation.create({ data: { name: "Event update", slug: organisationSlug } });
    organisationId = organisation.id;
    await prisma.membership.create({ data: { userId, organisationId, role: MembershipRole.OWNER } });
    const event = await prisma.event.create({
      data: { organisationId, title: "Doors open", slug: "doors-open", description: "Live now.", startDateTime: start, endDateTime: end, timezone: "UTC", location: "Main hall", status: EventStatus.PUBLISHED },
    });
    eventId = event.id;
    identity.id = userId;
  });

  afterAll(async () => {
    identity.id = "";
    await prisma.organisation.deleteMany({ where: { id: organisationId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("still saves details and visibility while the start time is unchanged", async () => {
    expect(await updateEvent(input())).toEqual({ ok: true });
    expect(await updateEvent(input({ status: EventStatus.HIDDEN }))).toEqual({ ok: true });
    const saved = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(saved).toMatchObject({ title: "Doors are open", status: EventStatus.HIDDEN });
  });

  it("refuses to move the start to another time in the past", async () => {
    const earlier = new Date(start.getTime() - 60 * 60_000).toISOString();
    expect(await updateEvent(input({ startDateTime: earlier }))).toMatchObject({ ok: false, fieldErrors: { startDateTime: ["Start time must be now or in the future"] } });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).startDateTime.toISOString()).toBe(start.toISOString());
  });

  it("keeps a stored time with seconds when the form sends the same minute", async () => {
    const withSeconds = { start: new Date(start.getTime() + 17_000), end: new Date(end.getTime() + 42_000) };
    await prisma.event.update({ where: { id: eventId }, data: { startDateTime: withSeconds.start, endDateTime: withSeconds.end } });
    expect(await updateEvent(input({ status: EventStatus.PUBLISHED, title: "Doors are open again" }))).toEqual({ ok: true });
    const saved = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    expect(saved.startDateTime.toISOString()).toBe(withSeconds.start.toISOString());
    expect(saved.endDateTime.toISOString()).toBe(withSeconds.end.toISOString());
    expect(saved.title).toBe("Doors are open again");
  });
});
