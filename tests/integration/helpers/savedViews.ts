import { randomUUID } from "node:crypto";
import { EventStatus, JudgingStatus, RegistrationMode, RsvpStatus, type Event } from "@prisma/client";
import { prisma } from "@/lib/db";

// Unique slugs and seed helpers for saved-views.db.test.ts.

export const suffix = randomUUID().replaceAll("-", "");
export const orgSlug = `views-${suffix}`;
export const otherOrgSlug = `views-other-${suffix}`;
let sequence = 0;

export async function createEvent(orgId: string, mode: RegistrationMode = RegistrationMode.TEAM): Promise<Event> {
  return prisma.event.create({
    data: {
      organisationId: orgId,
      title: `Views ${suffix}`,
      slug: `views-${suffix}-${randomUUID().slice(0, 8)}`,
      startDateTime: new Date("2035-01-01T10:00:00.000Z"),
      endDateTime: new Date("2035-01-02T10:00:00.000Z"),
      timezone: "UTC",
      status: EventStatus.PUBLISHED,
      registrationMode: mode,
      teamMinSize: mode === RegistrationMode.TEAM ? 2 : undefined,
      teamMaxSize: mode === RegistrationMode.TEAM ? 4 : undefined,
      submissionsEnabled: true,
      judgingStatus: JudgingStatus.OPEN,
      page: { create: { isPublished: true } },
    },
  });
}

export async function rsvp(event: Event, options: { status?: RsvpStatus; teamId?: string | null; checkedIn?: boolean; name?: string } = {}) {
  sequence += 1;
  return prisma.rSVP.create({
    data: {
      eventId: event.id,
      guestEmail: `guest-${sequence}-${suffix}@example.test`,
      guestName: options.name ?? `Guest ${sequence}`,
      attendeeKey: `guest:guest-${sequence}-${suffix}@example.test`,
      status: options.status ?? RsvpStatus.CONFIRMED,
      teamId: options.teamId ?? null,
      checkedInAt: options.checkedIn ? new Date() : null,
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, sequence)),
    },
  });
}

export async function team(event: Event, name: string, options: { status?: RsvpStatus; members?: number; looking?: boolean } = {}) {
  sequence += 1;
  const created = await prisma.team.create({
    data: {
      eventId: event.id,
      name,
      nameKey: name.toLowerCase(),
      status: options.status ?? RsvpStatus.CONFIRMED,
      joinToken: `join-${randomUUID()}`,
      manageTokenHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      lookingForMembers: options.looking ?? false,
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, sequence)),
    },
  });
  for (let index = 0; index < (options.members ?? 2); index += 1) await rsvp(event, { status: options.status ?? RsvpStatus.CONFIRMED, teamId: created.id });
  return created;
}
