import "server-only";

import { CrewKind, EventStatus, Prisma } from "@prisma/client";
import { z } from "zod";
import { isUploadedImageUrl } from "@/lib/uploadUrl";

/** Schemas, limits and small helpers shared by the crew cores (docs/CREW.md). */

export const CREW_PHOTO_CATEGORY = "event-crew";
export const MAX_CREW_MEMBERS = 500;
/** Offered as suggestions; any short text is accepted. */
export const FOOD_PREFERENCE_SUGGESTIONS = ["Vegetarian", "Non-vegetarian", "Vegan", "Jain", "Eggetarian", "No preference"] as const;

export const ALREADY_ON_CREW = "This email is already on the crew.";
export const ALREADY_REGISTERED = "This email is already registered for this event.";
/** Crew tickets are added, edited and removed with their crew record only. */
export const CREW_REGISTRATION_ERROR = "This person is on the event crew. Manage them from Guests → Crew.";
/** Registration and checkout refuse an email that already holds a crew ticket. */
export const CREW_EMAIL_REFUSED = "This email is on the event crew and already has a crew ticket. Ask the organisers if you need a different place.";

export type OrganiserCrewContext = { organisationId: string; eventId: string; actorUserId: string };
export type CrewResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

export const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const httpUrl = z
  .string()
  .trim()
  .max(500)
  .url()
  // Zod still runs this refinement after `.url()` fails, so it must not throw on a malformed value.
  .refine((value) => URL.canParse(value) && /^https?:$/.test(new URL(value).protocol), "Use an HTTP(S) URL");

/** Fields a crew member or organiser can set. Names follow the attendee rules: plain text, no markup. */
export const crewProfileSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name.").max(120),
    email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(254),
    foodPreference: z.string().trim().max(80).default(""),
    role: z.string().trim().max(120).default(""),
    bio: z.string().trim().max(600).default(""),
    photoUrl: z.union([z.string().refine(isUploadedImageUrl, "Invalid uploaded image URL"), z.literal(""), z.null()]).optional(),
    linkedinUrl: z.union([httpUrl, z.literal(""), z.null()]).optional(),
  })
  .strict();

/**
 * Organisers also choose the crew kind (display, badges and filters only;
 * never authority). Omitted: VOLUNTEER for a new member, unchanged on edit.
 */
export const organiserCrewSchema = crewProfileSchema.extend({ showOnPage: z.boolean().default(true), kind: z.nativeEnum(CrewKind).optional() }).strict();

export type CrewProfileInput = z.infer<typeof crewProfileSchema>;

export function cleanProfile(profile: CrewProfileInput) {
  return {
    name: profile.name,
    email: profile.email,
    foodPreference: profile.foodPreference,
    role: profile.role,
    bio: profile.bio,
    photoUrl: profile.photoUrl || null,
    linkedinUrl: profile.linkedinUrl || null,
  };
}

/** Food preferences grouped case-insensitively, most common first; blanks are "Not given". */
export function summariseFoodPreferences(values: readonly string[]): Array<{ label: string; count: number }> {
  const groups = new Map<string, { label: string; count: number }>();
  for (const raw of values) {
    const label = raw.trim() || "Not given";
    const key = label.toLowerCase();
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { label, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export type EventForCrew = { id: string; organisationId: string; title: string; status: EventStatus; endDateTime: Date };
export const eventForCrewSelect = { id: true, organisationId: true, title: true, status: true, endDateTime: true } as const satisfies Prisma.EventSelect;

/**
 * The same Event row lock every capacity, payment and team change takes, so
 * turning an attendee into crew cannot interleave with a registration.
 */
export async function lockEventForCrew(tx: Prisma.TransactionClient, eventId: string): Promise<EventForCrew | null> {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  return tx.event.findUnique({ where: { id: eventId }, select: eventForCrewSelect });
}

export function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Which table a unique violation came from: the crew list, or the event's registrations. */
export function uniqueViolationModel(error: unknown): string | undefined {
  return error instanceof Prisma.PrismaClientKnownRequestError ? (error.meta?.modelName as string | undefined) : undefined;
}

/**
 * The event's registration for this email, guest or account-tied, if any
 * (optionally not counting one RSVP, such as the crew ticket being edited).
 * Callers hold the Event row lock.
 */
export function findRegistrationByEmail(tx: Prisma.TransactionClient, eventId: string, email: string, exceptRsvpId?: string) {
  return tx.rSVP.findFirst({
    where: {
      eventId,
      ...(exceptRsvpId ? { id: { not: exceptRsvpId } } : {}),
      OR: [{ attendeeKey: `guest:${email}` }, { guestEmail: { equals: email, mode: "insensitive" } }, { user: { email: { equals: email, mode: "insensitive" } } }],
    },
    select: { id: true, status: true, teamId: true, orderId: true, ticketTypeId: true, userId: true, submission: { select: { id: true } } },
  });
}

/** Locks the event row (the capacity and crew lock), then asks `hasCrewEmail`. */
export async function lockedHasCrewEmail(tx: Prisma.TransactionClient, eventId: string, emails: readonly (string | null | undefined)[]) {
  await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
  return hasCrewEmail(tx, eventId, emails);
}

/**
 * The account a crew email belongs to, for `EventCrewMember.userId`: only a
 * verified account with exactly that email. The link lets that person find
 * their crew record and stops them verifying their own hours; it never
 * grants anything.
 */
export async function verifiedAccountFor(client: Prisma.TransactionClient, email: string): Promise<string | null> {
  const user = await client.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, emailVerified: { not: null } }, select: { id: true } });
  return user?.id ?? null;
}

/**
 * Links an account to its crew records by verified email, for example when it
 * accepts an event invitation. Only unlinked rows change. Safe to run twice.
 */
export async function linkCrewAccount(client: Prisma.TransactionClient, userId: string, email: string | null | undefined, eventId?: string) {
  const normalised = email?.trim().toLowerCase();
  if (!normalised) return 0;
  const linked = await client.eventCrewMember.updateMany({ where: { email: normalised, userId: null, ...(eventId ? { eventId } : {}) }, data: { userId } });
  return linked.count;
}

/**
 * Whether any of these emails already holds a crew place on the event. The
 * registration and checkout cores call it under the Event row lock, so a
 * crew member never gets a second, capacity-taking registration.
 */
export async function hasCrewEmail(client: Prisma.TransactionClient, eventId: string, emails: readonly (string | null | undefined)[]): Promise<boolean> {
  const normalised = [...new Set(emails.flatMap((email) => (email?.trim() ? [email.trim().toLowerCase()] : [])))];
  if (normalised.length === 0) return false;
  return (await client.eventCrewMember.count({ where: { eventId, email: { in: normalised } } })) > 0;
}
