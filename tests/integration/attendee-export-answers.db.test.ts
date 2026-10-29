import { randomUUID } from "node:crypto";
import { EventStatus, MembershipRole, RegistrationFieldType, RsvpStatus, type Event } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({ auth: async () => (session.userId ? { user: { id: session.userId } } : null) }));
vi.mock("@/lib/audit", () => ({ recordAuditEvent: async () => undefined }));
vi.mock("@/lib/publicUrl", () => ({ getRequestOrigin: async () => "https://events.example.test" }));

import { prisma } from "@/lib/db";
import { GET as exportAttendees } from "@/app/api/exports/events/[eventId]/attendees/route";
import { csv } from "./helpers/filteredExports";

/*
 * Attendee CSV answers (audit: Data Layer, Privacy): a multi-select stores
 * one answer row per choice, and the export keeps every choice in one cell,
 * in the question's option order and then by value, still formula-safe.
 */

const suffix = randomUUID().replaceAll("-", "");
const FORMULA = '=HYPERLINK("https://evil.example")';
let organisationId = "";
let ownerId = "";
let event: Event;
let workshopsId = "";
let roleId = "";

async function register(name: string, answers: Array<{ fieldId: string; valueText: string }>) {
  const email = `${name.toLowerCase()}-${suffix}@example.test`;
  const rsvp = await prisma.rSVP.create({ data: { eventId: event.id, guestEmail: email, guestName: name, attendeeKey: `guest:${email}`, status: RsvpStatus.CONFIRMED } });
  // Stored one row at a time, deliberately out of option order.
  for (const answer of answers) await prisma.rsvpAnswer.create({ data: { rsvpId: rsvp.id, ...answer } });
}

beforeAll(async () => {
  organisationId = (await prisma.organisation.create({ data: { name: `Answers ${suffix}`, slug: `answers-${suffix}` } })).id;
  ownerId = (await prisma.user.create({ data: { name: "Answers owner", email: `owner-${suffix}@example.test`, memberships: { create: { organisationId, role: MembershipRole.OWNER } } } })).id;
  event = await prisma.event.create({ data: {
    organisationId, title: `Answers ${suffix}`, slug: `answers-${suffix}`, timezone: "UTC", status: EventStatus.PUBLISHED,
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"),
  } });
  const form = await prisma.eventRegistrationForm.create({ data: { eventId: event.id, fields: { create: [
    { key: "workshops", label: "Workshops", type: RegistrationFieldType.MULTI_SELECT, sortOrder: 0, options: ["Workshop C", " Workshop A ", "Workshop B"], settings: { allowOther: true } },
    { key: "role", label: "Role", type: RegistrationFieldType.TEXT, sortOrder: 1 },
  ] } }, include: { fields: true } });
  workshopsId = form.fields.find((field) => field.key === "workshops")!.id;
  roleId = form.fields.find((field) => field.key === "role")!.id;
  await register("Ada", [
    { fieldId: workshopsId, valueText: "Zine making" },
    { fieldId: workshopsId, valueText: "Workshop B" },
    { fieldId: roleId, valueText: "Designer" },
    { fieldId: workshopsId, valueText: "Workshop A" },
    { fieldId: workshopsId, valueText: "Bookbinding" },
    { fieldId: workshopsId, valueText: "Workshop C" },
  ]);
  await register("Grace", [{ fieldId: workshopsId, valueText: FORMULA }, { fieldId: roleId, valueText: "-1+1" }]);
  await register("Linus", []);
  session.userId = ownerId;
});

afterAll(async () => {
  await prisma.organisation.deleteMany({ where: { id: organisationId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
});

describe("attendee CSV answers", () => {
  it("keeps every multi-select choice in option order, then other text by value, with formulas neutralised", async () => {
    const { header, rows } = await csv(await exportAttendees(new Request(`https://events.example.test/api/exports/events/${event.id}/attendees`), { params: Promise.resolve({ eventId: event.id }) }));
    const workshops = header.indexOf("Workshops");
    const role = header.indexOf("Role");
    expect(workshops).toBeGreaterThan(-1);
    expect(role).toBe(workshops + 1);
    const byName = new Map(rows.map((row) => [row[0], row]));
    expect(byName.get("Ada")![workshops]).toBe("Workshop C; Workshop A; Workshop B; Bookbinding; Zine making");
    expect(byName.get("Ada")![role]).toBe("Designer");
    expect(byName.get("Grace")![workshops]).toBe(`'${FORMULA}`);
    expect(byName.get("Grace")![role]).toBe("'-1+1");
    expect(byName.get("Linus")![workshops]).toBe("");
    // The same file twice: the order never depends on how rows came back.
    const again = await csv(await exportAttendees(new Request(`https://events.example.test/api/exports/events/${event.id}/attendees`), { params: Promise.resolve({ eventId: event.id }) }));
    expect(again.rows).toEqual(rows);
  });
});
