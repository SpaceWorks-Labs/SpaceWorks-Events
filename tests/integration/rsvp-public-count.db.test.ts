import { EventStatus, RegistrationMode, RsvpStatus, SoloPolicy } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth", () => ({ auth: async () => (identity.id ? { user: { id: identity.id } } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined, updateTag: () => undefined }));
vi.mock("@/lib/actionRateLimit", () => ({ isActionRateLimited: async () => false }));
vi.mock("@/lib/rateLimit", async (original) => ({ ...(await original<typeof import("@/lib/rateLimit")>()), checkRateLimitById: async () => true }));

import { prisma } from "@/lib/db";
import { submitRsvpCore } from "@/lib/rsvpCore";
import { submitRsvp } from "@/app/actions/rsvp";
import { POST as postRsvp } from "@/app/api/rsvp/route";
import { countConfirmedForEvent } from "@/lib/rsvpCapacity";
import { countCrewTickets } from "@/lib/core/crew/public";
import type { ActionResult } from "@/app/actions/org";
import { paid, setUpPaidOrg, tearDownPaidOrg } from "./helpers/paidOrg";

/*
 * The registration count returned to a registrant (audit: Public HTTP
 * Routes): left out when the event hides its count, and otherwise the same
 * number the event page shows (confirmed attendees plus crew, or team units),
 * on the free guest, signed-in, paid-order and series paths.
 */

let counter = 0;
let userId = "";
function dataOf<T>(result: ActionResult<T>) {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const email = (who: string) => `${who}-${paid.suffix}@example.test`;

async function makeEvent(options: { show: boolean; capacity?: number | null; team?: boolean; price?: number }) {
  counter += 1;
  const event = await prisma.event.create({ data: {
    organisationId: paid.organisationId, title: `Count ${counter}`, slug: `count-${paid.suffix}-${counter}`, currency: "INR",
    startDateTime: new Date("2035-01-01T10:00:00.000Z"), endDateTime: new Date("2035-01-02T10:00:00.000Z"), timezone: "UTC",
    capacity: options.capacity ?? null, status: EventStatus.PUBLISHED, showRegistrationCount: options.show,
    ...(options.team ? { registrationMode: RegistrationMode.TEAM, teamMaxSize: 3, soloPolicy: SoloPolicy.SOLO_ALLOWED } : {}),
    page: { create: { isPublished: true } },
  } });
  const ticket = options.price === undefined ? null : await prisma.ticketType.create({ data: { eventId: event.id, name: "Entry", priceMinor: BigInt(options.price) } });
  return { event, ticket };
}

/** Registrations the page never counts, plus one crew ticket it does (INDIVIDUAL events only). */
async function seedOthers(eventId: string, crew = true) {
  for (const status of [RsvpStatus.WAITLISTED, RsvpStatus.REJECTED, RsvpStatus.PENDING_APPROVAL]) {
    const address = email(`${status.toLowerCase()}-${eventId}`);
    await prisma.rSVP.create({ data: { eventId, guestEmail: address, guestName: status, attendeeKey: `guest:${address}`, status } });
  }
  if (crew) {
    const address = email(`crew-${eventId}`);
    await prisma.rSVP.create({ data: { eventId, guestEmail: address, guestName: "Crew", attendeeKey: `guest:${address}`, status: RsvpStatus.CONFIRMED, isCrew: true } });
  }
}

async function pageCount(eventId: string, mode: RegistrationMode = RegistrationMode.INDIVIDUAL) {
  return (await countConfirmedForEvent(eventId, mode)) + (mode === RegistrationMode.TEAM ? 0 : await countCrewTickets(eventId));
}

const guest = (eventSlug: string, who: string, extra: Record<string, unknown> = {}) =>
  submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug, guestEmail: email(who), name: "Count Guest", answers: {}, ...extra }, { userId: null });

beforeAll(async () => {
  await setUpPaidOrg("Count");
  userId = (await prisma.user.create({ data: { name: "Signed In", email: email("signed-in"), emailVerified: new Date() } })).id;
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await tearDownPaidOrg();
});

describe("registration count in the registration response", () => {
  it("leaves the count out of free guest, signed-in, action and route answers when the event hides it", async () => {
    const { event } = await makeEvent({ show: false });
    await seedOthers(event.id);
    const asGuest = await guest(event.slug, "hidden-guest");
    expect(asGuest.ok).toBe(true);
    expect(dataOf(asGuest)).not.toHaveProperty("count");
    const signedIn = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, answers: {} }, { userId });
    expect(signedIn.ok).toBe(true);
    expect(dataOf(signedIn)?.count).toBeUndefined();
    const action = await submitRsvp({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("hidden-action"), name: "Count Guest", answers: {} });
    expect(action.ok).toBe(true);
    expect(dataOf(action)?.count).toBeUndefined();
    const response = await postRsvp(new Request("https://events.example.test/api/rsvp", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("hidden-route"), name: "Count Guest", answers: {} }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).not.toHaveProperty("count");
  });

  it("returns the page's count when shown: confirmed attendees plus crew, never waitlisted, rejected or pending", async () => {
    const { event } = await makeEvent({ show: true, capacity: 2 });
    await seedOthers(event.id);
    const first = await guest(event.slug, "shown-first");
    expect(first).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED, count: 2 } });
    expect(dataOf(first)?.count).toBe(await pageCount(event.id));
    const signedIn = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, answers: {} }, { userId });
    expect(signedIn).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED, count: 3 } });
    const waitlisted = await guest(event.slug, "shown-waitlisted");
    expect(waitlisted).toMatchObject({ ok: true, data: { status: RsvpStatus.WAITLISTED, count: 3 } });
    expect(dataOf(waitlisted)?.count).toBe(await pageCount(event.id));
  });

  it("counts team units on a TEAM event, as its page does", async () => {
    const { event } = await makeEvent({ show: true, team: true });
    const solo = await guest(event.slug, "team-solo");
    expect(solo).toMatchObject({ ok: true, data: { count: 1 } });
    const lead = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("team-create"), name: "Team Lead", answers: {} }, { userId: null, team: { mode: "create", name: `Squad ${paid.suffix}` } });
    expect(lead).toMatchObject({ ok: true, data: { count: 2 } });
    const squad = await prisma.team.findFirstOrThrow({ where: { eventId: event.id } });
    const member = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: event.slug, guestEmail: email("team-join"), name: "Team Member", answers: {} }, { userId: null, team: { mode: "join", joinToken: squad.joinToken } });
    // Joining a team takes no new place: "2 places taken", as on the page.
    expect(member).toMatchObject({ ok: true, data: { count: 2 } });
    expect(dataOf(member)?.count).toBe(await pageCount(event.id, RegistrationMode.TEAM));
  });

  it("applies the same rule to a paid ticket order", async () => {
    const hidden = await makeEvent({ show: false, price: 49900 });
    await seedOthers(hidden.event.id);
    const items = (ticketTypeId: string) => ({ items: [{ ticketTypeId, quantity: 1 }], attendees: [] });
    const hiddenOrder = await guest(hidden.event.slug, "paid-hidden", items(hidden.ticket!.id));
    expect(hiddenOrder.ok).toBe(true);
    expect(dataOf(hiddenOrder)).not.toHaveProperty("count");
    expect(dataOf(hiddenOrder)?.orderToken).toBeTruthy();
    const hiddenSignedIn = await submitRsvpCore({ orgSlug: paid.orgSlug, eventSlug: hidden.event.slug, answers: {}, ...items(hidden.ticket!.id) }, { userId });
    expect(hiddenSignedIn.ok).toBe(true);
    expect(dataOf(hiddenSignedIn)?.count).toBeUndefined();

    const shown = await makeEvent({ show: true, price: 49900 });
    await seedOthers(shown.event.id);
    const shownOrder = await guest(shown.event.slug, "paid-shown", items(shown.ticket!.id));
    expect(shownOrder.ok).toBe(true);
    // The held, unpaid ticket is not "going" yet: only the crew ticket is counted.
    expect(dataOf(shownOrder)?.count).toBe(1);
    expect(dataOf(shownOrder)?.count).toBe(await pageCount(shown.event.id));
  });

  it("returns a series date's confirmed registrations, as its page does", async () => {
    counter += 1;
    const series = await prisma.eventSeries.create({ data: {
      organisationId: paid.organisationId, title: `Series ${counter}`, slug: `count-series-${paid.suffix}-${counter}`, recurrenceRule: "FREQ=WEEKLY;COUNT=2", timezone: "UTC", status: EventStatus.PUBLISHED,
    } });
    const date = await prisma.eventInstance.create({ data: { eventSeriesId: series.id, startDateTime: new Date("2035-02-01T10:00:00.000Z"), endDateTime: new Date("2035-02-01T12:00:00.000Z") } });
    const waiting = email("series-waiting");
    await prisma.rSVP.create({ data: { eventInstanceId: date.id, guestEmail: waiting, guestName: "Waiting", attendeeKey: `guest:${waiting}`, status: RsvpStatus.WAITLISTED } });
    const result = await submitRsvpCore({ orgSlug: paid.orgSlug, eventInstanceId: date.id, guestEmail: email("series-guest"), name: "Series Guest", answers: {} }, { userId: null });
    expect(result).toMatchObject({ ok: true, data: { status: RsvpStatus.CONFIRMED, count: 1 } });
  });
});
