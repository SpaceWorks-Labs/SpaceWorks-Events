import { EventStatus, RegistrationMode, RsvpStatus } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { prisma } from "@/lib/db";
import { flushWebhookEmits } from "@/lib/webhooks/emit";
import { joinCrew } from "@/app/actions/crew";
import { purgeUnusedCrewPhotos } from "@/lib/core/crew/photos";
import { randomUUID } from "node:crypto";
import {
  addCrewMemberAsOrganiser,
  getCrewJoinLink,
  joinCrewWithLink,
  listCrewForOrganiser,
  listPublicCrew,
  loadCrewJoinPage,
  MAX_CREW_MEMBERS,
  moveCrewMember,
  removeCrewMember,
  setCrewJoinLink,
  setCrewMemberVisibility,
  updateCrewMemberAsOrganiser,
} from "@/lib/core/crew";
import { addCrew, createCrewEvent, crew, crewEmail, ctxFor, register, setUpCrewOrgs, tearDownCrewOrgs, type CrewEventOptions } from "./helpers/crew";

/* The crew sign-up link (docs/CREW.md): lifecycle, no enumeration, closed events, hidden sign-ups, tenancy. */

async function linkFor(options: CrewEventOptions = {}) {
  const event = await createCrewEvent(options);
  const link = await setCrewJoinLink(ctxFor(event), "create");
  if (!link.ok || !link.data) throw new Error("link not created");
  return { event, token: link.data.token };
}

describe.sequential("crew join link", () => {
  beforeAll(() => setUpCrewOrgs("link"));
  afterAll(async () => {
    await flushWebhookEmits();
    await tearDownCrewOrgs();
  });

  it("creates, keeps, rotates and disables the link", async () => {
    const event = await createCrewEvent();
    await expect(getCrewJoinLink(ctxFor(event))).resolves.toBeNull();
    const created = await setCrewJoinLink(ctxFor(event), "create");
    if (!created.ok || !created.data) throw new Error("link not created");
    const original = created.data.token;
    expect(original).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(setCrewJoinLink(ctxFor(event), "create")).resolves.toEqual({ ok: true, data: { token: original } });
    await expect(loadCrewJoinPage(original)).resolves.toMatchObject({ eventId: event.id, organisationId: crew.organisationId, eventTitle: event.title, open: true });

    const rotated = await setCrewJoinLink(ctxFor(event), "rotate");
    if (!rotated.ok || !rotated.data) throw new Error("link not rotated");
    expect(rotated.data.token).not.toBe(original);
    await expect(loadCrewJoinPage(original)).resolves.toBeNull();
    await expect(joinCrewWithLink(original, { name: "Old link", email: crewEmail("old") })).resolves.toEqual({ ok: false, error: expect.stringContaining("no longer valid") });

    await expect(setCrewJoinLink(ctxFor(event), "disable")).resolves.toEqual({ ok: true, data: null });
    await expect(loadCrewJoinPage(rotated.data.token)).resolves.toBeNull();
    await expect(getCrewJoinLink(ctxFor(event))).resolves.toBeNull();
    await expect(loadCrewJoinPage("not a token")).resolves.toBeNull();
    await expect(loadCrewJoinPage("a".repeat(43))).resolves.toBeNull();
  });

  it("adds link sign-ups hidden until reviewed, with a ticket and a chat notice", async () => {
    const { event, token } = await linkFor();
    // Only the queued notice matters here; delivery is the worker's job.
    const channel = await prisma.chatChannel.create({ data: { organisationId: crew.organisationId, kind: "SLACK", name: "Crew", events: ["registration"], secretEncrypted: "pending" } });
    const memberEmail = crewEmail("volunteer");
    await expect(joinCrewWithLink(token, { name: " Volunteer ", email: memberEmail.toUpperCase(), foodPreference: "Jain", role: "Stage" })).resolves.toEqual({ ok: true, data: { eventTitle: event.title, changed: true } });
    const member = await prisma.eventCrewMember.findFirstOrThrow({ where: { eventId: event.id }, include: { rsvp: true } });
    expect(member).toMatchObject({ name: "Volunteer", email: memberEmail, showOnPage: false, joinedViaLink: true, foodPreference: "Jain", role: "Stage" });
    expect(member.rsvp).toMatchObject({ status: RsvpStatus.CONFIRMED, isCrew: true });
    await expect(prisma.outboxMessage.count({ where: { kind: "crew-ticket", payload: { path: ["to"], equals: memberEmail } } })).resolves.toBe(1);
    await expect(prisma.outboxMessage.count({ where: { kind: "chat-message", payload: { path: ["channelId"], equals: channel.id } } })).resolves.toBe(1);
    await expect(listPublicCrew(event.id)).resolves.toEqual([]);

    // The public form cannot choose its own visibility.
    await expect(joinCrewWithLink(token, { name: "Pushy", email: crewEmail("pushy"), showOnPage: true })).resolves.toMatchObject({ ok: false });
    await expect(prisma.eventCrewMember.count({ where: { eventId: event.id } })).resolves.toBe(1);
    await expect(setCrewMemberVisibility(ctxFor(event), member.id, true)).resolves.toEqual({ ok: true, data: undefined });
    await expect(listPublicCrew(event.id)).resolves.toHaveLength(1);
  });

  it("answers an email already on the crew exactly like a new sign-up, and adds nothing", async () => {
    const { event, token } = await linkFor();
    const member = await addCrew(event);
    await expect(joinCrewWithLink(token, { name: "Again", email: member.email })).resolves.toEqual({ ok: true, data: { eventTitle: event.title, changed: false } });
    await expect(prisma.eventCrewMember.count({ where: { eventId: event.id } })).resolves.toBe(1);
    await expect(prisma.rSVP.count({ where: { eventId: event.id } })).resolves.toBe(1);
  });

  it("audits a link sign-up only when someone joined, with the same answer either way", async () => {
    const { event, token } = await linkFor();
    const audits = () => prisma.auditEvent.count({ where: { action: "EVENT_CREW_JOINED_WITH_LINK", targetId: event.id } });
    const memberEmail = crewEmail("audited");
    await expect(joinCrew({ token, member: { name: "Audited", email: memberEmail } })).resolves.toEqual({ ok: true, data: { eventTitle: event.title } });
    await expect(audits()).resolves.toBe(1);
    await expect(joinCrew({ token, member: { name: "Audited", email: memberEmail } })).resolves.toEqual({ ok: true, data: { eventTitle: event.title } });
    await expect(audits()).resolves.toBe(1);
  });

  it("never converts a registration through the link, and answers the same way", async () => {
    const { event, token } = await linkFor({ capacity: 1 });
    await register(event, "first");
    const waiting = await register(event, "waiting");
    await expect(joinCrewWithLink(token, { name: "Sneaky", email: waiting.email })).resolves.toEqual({ ok: true, data: { eventTitle: event.title, changed: false } });
    await expect(prisma.rSVP.findUniqueOrThrow({ where: { id: waiting.rsvp.id } })).resolves.toMatchObject({ status: RsvpStatus.WAITLISTED, isCrew: false });
    await expect(prisma.eventCrewMember.count({ where: { eventId: event.id } })).resolves.toBe(0);

    const team = await linkFor({ registrationMode: RegistrationMode.TEAM });
    const leader = await register(team.event, "leader", { mode: "create", name: `Kites ${crew.suffix}` });
    await expect(joinCrewWithLink(team.token, { name: "Leader", email: leader.email })).resolves.toEqual({ ok: true, data: { eventTitle: team.event.title, changed: false } });
    await expect(prisma.eventCrewMember.count({ where: { eventId: team.event.id } })).resolves.toBe(0);
  });

  it("refuses sign-ups for cancelled and ended events", async () => {
    for (const options of [{ status: EventStatus.CANCELLED }, { ended: true }] satisfies CrewEventOptions[]) {
      const { event, token } = await linkFor(options);
      await expect(loadCrewJoinPage(token)).resolves.toMatchObject({ open: false });
      await expect(joinCrewWithLink(token, { name: "Late", email: crewEmail("late") })).resolves.toEqual({ ok: false, error: "This event is no longer taking crew sign-ups." });
      await expect(prisma.eventCrewMember.count({ where: { eventId: event.id } })).resolves.toBe(0);
    }
  });

  it("validates field limits and caps a crew at the maximum", async () => {
    const { event, token } = await linkFor();
    await expect(joinCrewWithLink(token, { name: "n".repeat(121), email: crewEmail("long") })).resolves.toMatchObject({ ok: false });
    await expect(joinCrewWithLink(token, { name: "Bio", email: crewEmail("bio"), bio: "b".repeat(601) })).resolves.toMatchObject({ ok: false });
    await expect(joinCrewWithLink(token, { name: "Link", email: crewEmail("li"), linkedinUrl: "javascript:alert(1)" })).resolves.toMatchObject({ ok: false });
    await expect(joinCrewWithLink(token, { name: "Photo", email: crewEmail("ph"), photoUrl: "https://evil.example/p.webp" })).resolves.toMatchObject({ ok: false });
    // A crew upload from another organisation is refused too.
    const foreign = `/api/uploads/organisations/${crew.otherOrganisationId}/event-crew/123e4567-e89b-42d3-a456-426614174000.webp`;
    await expect(addCrewMemberAsOrganiser(ctxFor(event), { name: "Foreign", email: crewEmail("fp"), photoUrl: foreign })).resolves.toEqual({ ok: false, error: "Choose an uploaded crew photo." });

    const rows = Array.from({ length: MAX_CREW_MEMBERS }, (_, index) => ({ eventId: event.id, guestEmail: `cap-${index}-${crew.suffix}@example.test`, attendeeKey: `guest:cap-${index}-${crew.suffix}@example.test`, status: RsvpStatus.CONFIRMED, isCrew: true }));
    await prisma.rSVP.createMany({ data: rows });
    const created = await prisma.rSVP.findMany({ where: { eventId: event.id, isCrew: true }, select: { id: true, guestEmail: true } });
    await prisma.eventCrewMember.createMany({ data: created.map((row, index) => ({ eventId: event.id, rsvpId: row.id, name: `Cap ${index}`, email: row.guestEmail! })) });
    await expect(joinCrewWithLink(token, { name: "One more", email: crewEmail("over") })).resolves.toEqual({ ok: false, error: `An event can have up to ${MAX_CREW_MEMBERS} crew members.` });
  });

  it("deletes crew photos nobody saved after a day, and keeps used and fresh ones (twice is safe)", async () => {
    const event = await createCrewEvent();
    const key = () => `organisations/${crew.organisationId}/event-crew/${randomUUID()}.webp`;
    const [abandoned, used, fresh] = [key(), key(), key()];
    const old = new Date(Date.now() - 25 * 60 * 60_000);
    await prisma.asset.createMany({ data: [
      { key: abandoned, contentType: "image/webp", provider: "database", fileData: new Uint8Array([1]), organisationId: crew.organisationId, createdAt: old },
      { key: used, contentType: "image/webp", provider: "database", fileData: new Uint8Array([1]), organisationId: crew.organisationId, createdAt: old },
      { key: fresh, contentType: "image/webp", provider: "database", fileData: new Uint8Array([1]), organisationId: crew.organisationId },
    ] });
    await addCrew(event, { photoUrl: `/api/uploads/${used}` });
    await purgeUnusedCrewPhotos();
    await purgeUnusedCrewPhotos();
    const left = (await prisma.asset.findMany({ where: { key: { in: [abandoned, used, fresh] } }, select: { key: true } })).map((asset) => asset.key).sort();
    expect(left).toEqual([used, fresh].sort());
  });

  it("keeps another organisation out", async () => {
    const event = await createCrewEvent();
    const member = await addCrew(event);
    await setCrewJoinLink(ctxFor(event), "create");
    const foreign = ctxFor(event, crew.otherOrganisationId);
    await expect(listCrewForOrganiser(foreign)).resolves.toEqual({ members: [], food: [] });
    await expect(getCrewJoinLink(foreign)).resolves.toBeNull();
    await expect(addCrewMemberAsOrganiser(foreign, { name: "Intruder", email: crewEmail("intruder") })).resolves.toEqual({ ok: false, error: "Event not found." });
    await expect(updateCrewMemberAsOrganiser(foreign, member.id, { name: "Changed", email: member.email })).resolves.toEqual({ ok: false, error: "Event not found." });
    await expect(setCrewMemberVisibility(foreign, member.id, false)).resolves.toEqual({ ok: false, error: "Crew member not found." });
    await expect(removeCrewMember(foreign, member.id)).resolves.toEqual({ ok: false, error: "Crew member not found." });
    await expect(moveCrewMember(foreign, member.id, 1)).resolves.toEqual({ ok: false, error: "Crew member not found." });
    await expect(setCrewJoinLink(foreign, "rotate")).resolves.toEqual({ ok: false, error: "Event not found." });
    await expect(setCrewJoinLink(foreign, "disable")).resolves.toEqual({ ok: false, error: "Event not found." });
    // A member id from another event in the right organisation is not found either.
    const otherEvent = await createCrewEvent();
    await expect(updateCrewMemberAsOrganiser(ctxFor(otherEvent), member.id, { name: "Changed", email: member.email })).resolves.toEqual({ ok: false, error: "Crew member not found." });
    await expect(prisma.eventCrewMember.findUniqueOrThrow({ where: { id: member.id } })).resolves.toMatchObject({ name: member.name, showOnPage: true });
    await expect(getCrewJoinLink(ctxFor(event))).resolves.not.toBeNull();
  });
});
