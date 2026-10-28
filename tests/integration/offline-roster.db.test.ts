import { randomUUID } from "node:crypto";
import { EventPrivacyType, EventStatus, MembershipRole, RegistrationFieldType, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/outboxWorker", () => ({ startOutboxWorker: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { downloadOfflineCheckInRoster } from "@/app/actions/checkin";

/*
 * The offline check-in roster is read set-based (registrations with their
 * user and team joined in SQL, then every answer at once): the rows must be
 * exactly what the per-registration relation reads produced.
 */

const suffix = randomUUID().replace(/-/g, "");
const ids = { org: "", other: "", event: "", owner: "", attendee: "", team: "" };

beforeAll(async () => {
  ids.org = (await prisma.organisation.create({ data: { name: `Roster ${suffix}`, slug: `roster-${suffix}` } })).id;
  ids.other = (await prisma.organisation.create({ data: { name: `Elsewhere ${suffix}`, slug: `roster-other-${suffix}` } })).id;
  ids.owner = (await prisma.user.create({ data: { email: `roster-owner-${suffix}@example.test`, emailVerified: new Date() } })).id;
  ids.attendee = (await prisma.user.create({ data: { email: `roster-user-${suffix}@example.test`, name: "Signed In Sam", emailVerified: new Date() } })).id;
  await prisma.membership.create({ data: { userId: ids.owner, organisationId: ids.org, role: MembershipRole.OWNER } });
  const event = await prisma.event.create({
    data: {
      organisationId: ids.org, title: "Roster event", slug: `roster-${suffix}`, timezone: "UTC",
      startDateTime: new Date(Date.now() + 86_400_000), endDateTime: new Date(Date.now() + 90_000_000),
      status: EventStatus.PUBLISHED, privacyType: EventPrivacyType.PUBLIC,
      registrationForm: { create: { fields: { create: [{ key: "diet", label: "Dietary needs", type: RegistrationFieldType.TEXT, sortOrder: 0 }] } } },
    },
    include: { registrationForm: { include: { fields: true } } },
  });
  ids.event = event.id;
  const field = event.registrationForm!.fields[0]!;
  ids.team = (await prisma.team.create({ data: { eventId: event.id, name: "Night Owls", nameKey: `night owls ${suffix}`, status: RsvpStatus.CONFIRMED, joinToken: `join-${suffix}`, manageTokenHash: `manage-${suffix}` } })).id;
  const guest = await prisma.rSVP.create({ data: { eventId: event.id, attendeeKey: `guest:g-${suffix}`, guestName: "Guest Gina", guestEmail: `g-${suffix}@example.test`, status: RsvpStatus.CONFIRMED, createdAt: new Date(Date.now() - 60_000) } });
  await prisma.rsvpAnswer.create({ data: { rsvpId: guest.id, fieldId: field.id, valueText: "Vegetarian" } });
  await prisma.rSVP.create({ data: { eventId: event.id, userId: ids.attendee, attendeeKey: `user:${ids.attendee}`, status: RsvpStatus.WAITLISTED, teamId: ids.team, checkedInAt: null } });
  await prisma.rSVP.create({ data: { eventId: event.id, attendeeKey: `guest:r-${suffix}`, guestName: "Rejected Rae", guestEmail: `r-${suffix}@example.test`, status: RsvpStatus.REJECTED } });
});

afterAll(async () => {
  identity.id = "";
  await prisma.organisation.deleteMany({ where: { id: { in: [ids.org, ids.other] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.attendee] } } });
  await prisma.$disconnect();
});

describe("offline check-in roster", () => {
  it("lists every eligible registration newest first with its user, team and answers", async () => {
    identity.id = ids.owner;
    const result = await downloadOfflineCheckInRoster({ organisationSlug: `roster-${suffix}`, eventId: ids.event });
    expect(result.ok).toBe(true);
    const rows = result.ok ? result.data!.rows : [];
    expect(rows.map((row) => row.displayName)).toEqual(["Signed In Sam", "Guest Gina"]);
    expect(rows[0]).toMatchObject({ email: `roster-user-${suffix}@example.test`, status: "WAITLISTED", teamName: "Night Owls", checkedInAt: null, registrationDetails: [] });
    expect(rows[1]).toMatchObject({ email: `g-${suffix}@example.test`, status: "CONFIRMED", teamName: null });
    expect(rows[1]!.registrationDetails).toEqual([expect.objectContaining({ label: "Dietary needs", value: "Vegetarian" })]);
    expect(rows.every((row) => typeof row.ticketToken === "string" && row.ticketToken.length > 0)).toBe(true);
  });

  it("refuses another organisation's event", async () => {
    identity.id = ids.owner;
    const otherEvent = await prisma.event.create({ data: { organisationId: ids.other, title: "Other", slug: `roster-o-${suffix}`, timezone: "UTC", startDateTime: new Date(), endDateTime: new Date(Date.now() + 3_600_000) } });
    const result = await downloadOfflineCheckInRoster({ organisationSlug: `roster-${suffix}`, eventId: otherEvent.id });
    expect(result.ok).toBe(false);
  });
});
