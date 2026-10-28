import "./serverOnly";
import type { PrismaClient } from "@prisma/client";
import { assertDisposableDatabase } from "../guard";
import { seedPeople, removeExisting } from "./people";
import { seedMainEvent } from "./mainEvent";
import { seedMainGuests } from "./guests";
import { seedOtherEvents, seedPastEvent } from "./pastEvent";
import { seedHackathon } from "./hackathon";
import { seedPaidEvent } from "./payments";
import { seedOrders } from "./orders";
import { seedFinance } from "./finance";
import { seedDesigns, seedInstance, seedIntegrations } from "./settings";

export { EMAILS, ORG_SLUG, PASSWORD } from "./common";

/*
 * Demo data for the in-app guide's screenshots (tests/help-screenshots).
 * Idempotent: it deletes its own organisations and users, then recreates
 * them, so it refuses to run anywhere but a disposable local database.
 */
export async function seedHelpScreens(prisma: PrismaClient) {
  assertDisposableDatabase();
  await removeExisting(prisma, []);
  const now = Date.now();
  const people = await seedPeople(prisma, now);
  const main = await seedMainEvent(prisma, people, now);
  const guests = await seedMainGuests(prisma, people, main, now);
  const past = await seedPastEvent(prisma, people, now);
  const { draft, series } = await seedOtherEvents(prisma, people, now);
  const { hack, submissions } = await seedHackathon(prisma, people, now);
  const paid = await seedPaidEvent(prisma, people, now, series);
  const orders = await seedOrders(prisma, people, paid, now);
  await seedFinance(prisma, people, paid.summit, orders.claimRsvpId, now);
  await seedIntegrations(prisma, people, now);
  const designs = await seedDesigns(prisma, people, { main, summit: paid.summit }, now);
  await seedInstance(prisma, people, now);

  const pick = (event: { id: string; slug: string; title: string }) => ({ id: event.id, slug: event.slug, title: event.title });
  return {
    events: { main: pick(main), past: pick(past), draft: pick(draft), hack: pick(hack), summit: pick(paid.summit) },
    seriesId: series.id,
    ticketToken: guests.ticketToken,
    orderToken: orders.orderToken,
    claimTicketToken: orders.claimTicketToken,
    submissions,
    ticketDesignId: designs.libraryDesignId,
    programmeId: designs.programmeId,
  };
}

export type SeedResult = Awaited<ReturnType<typeof seedHelpScreens>>;
