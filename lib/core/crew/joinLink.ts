import "server-only";

import crypto from "node:crypto";
import { EventStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { addCrewMemberTx, afterCrewAdded, LINK_SIGNUP_IGNORED, organiserEvent } from "./members";
import { ALREADY_ON_CREW, ALREADY_REGISTERED, crewProfileSchema, eventForCrewSelect, fail, type CrewResult, type OrganiserCrewContext } from "./shared";

/*
 * The crew sign-up link (docs/CREW.md). The token is the capability: 256
 * random bits, stored as-is like a team join token so organisers can copy it
 * again. Rotating replaces it and disabling deletes it, so an old link stops
 * working at once. Never log a token or put it in audit metadata.
 */

const CREW_TOKEN_BYTES = 32;

export function generateCrewJoinToken(): string {
  return crypto.randomBytes(CREW_TOKEN_BYTES).toString("base64url");
}

/** Shape check before any lookup, so malformed values never reach the database. */
export function isCrewJoinTokenShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function crewJoinPath(token: string): string {
  return `/crew/${encodeURIComponent(token)}`;
}

export async function getCrewJoinLink(ctx: OrganiserCrewContext): Promise<{ token: string; createdAt: string } | null> {
  const link = await prisma.eventCrewJoinLink.findFirst({
    where: { eventId: ctx.eventId, event: { organisationId: ctx.organisationId } },
    select: { token: true, createdAt: true },
  });
  return link ? { token: link.token, createdAt: link.createdAt.toISOString() } : null;
}

/** "create" keeps an existing link; "rotate" replaces it (the old link stops working); "disable" removes it. */
export async function setCrewJoinLink(ctx: OrganiserCrewContext, action: "create" | "rotate" | "disable"): Promise<CrewResult<{ token: string } | null>> {
  const event = await organiserEvent(ctx);
  if (!event) return fail("Event not found.");
  if (action === "disable") {
    await prisma.eventCrewJoinLink.deleteMany({ where: { eventId: event.id } });
    return { ok: true, data: null };
  }
  const token = generateCrewJoinToken();
  const link = await prisma.eventCrewJoinLink.upsert({
    where: { eventId: event.id },
    create: { eventId: event.id, token },
    update: action === "rotate" ? { token, createdAt: new Date() } : {},
    select: { token: true },
  });
  return { ok: true, data: { token: link.token } };
}

export type CrewJoinPage = {
  eventId: string;
  organisationId: string;
  organisationName: string;
  organisationSlug: string;
  eventTitle: string;
  eventSlug: string;
  startDateTime: string;
  timezone: string;
  /** False once the event is cancelled or over: the page explains instead of showing the form. */
  open: boolean;
};

function isCrewJoinOpen(event: { status: EventStatus; endDateTime: Date }) {
  return event.status !== EventStatus.CANCELLED && event.endDateTime > new Date();
}

/** What the public join page may show for a token: only the event and organiser names and the date. */
export async function loadCrewJoinPage(token: unknown): Promise<CrewJoinPage | null> {
  if (!isCrewJoinTokenShape(token)) return null;
  const link = await prisma.eventCrewJoinLink.findUnique({
    where: { token },
    select: { event: { select: { id: true, title: true, slug: true, status: true, startDateTime: true, endDateTime: true, timezone: true, organisation: { select: { id: true, name: true, slug: true } } } } },
  });
  if (!link) return null;
  const { event } = link;
  return {
    eventId: event.id,
    organisationId: event.organisation.id,
    organisationName: event.organisation.name,
    organisationSlug: event.organisation.slug,
    eventTitle: event.title,
    eventSlug: event.slug,
    startDateTime: event.startDateTime.toISOString(),
    timezone: event.timezone,
    open: isCrewJoinOpen(event),
  };
}

const INVALID_LINK = "This crew link is no longer valid. Ask the organisers for a new one.";

/**
 * Self sign-up through the crew link. The member starts hidden from the
 * public page until an organiser reviews them, and gets their ticket by email.
 * An email already on the crew or already registered gets the same answer as
 * a new sign-up and changes nothing. Callers rate limit before calling.
 */
export async function joinCrewWithLink(token: unknown, input: unknown): Promise<CrewResult<{ eventTitle: string }>> {
  const page = await loadCrewJoinPage(token);
  if (!page) return fail(INVALID_LINK);
  if (!page.open) return fail("This event is no longer taking crew sign-ups.");
  const parsed = crewProfileSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check your details.");
  const event = await prisma.event.findUnique({ where: { id: page.eventId }, select: eventForCrewSelect });
  if (!event) return fail(INVALID_LINK);
  const result = await addCrewMemberTx(event, parsed.data, { showOnPage: false, joinedViaLink: true });
  await afterCrewAdded(event.id, result);
  // Generic wording: the link must not reveal whether an email is on the crew or registered.
  if (!result.ok && ![ALREADY_ON_CREW, ALREADY_REGISTERED, LINK_SIGNUP_IGNORED].includes(result.error)) return result;
  return { ok: true, data: { eventTitle: event.title } };
}
