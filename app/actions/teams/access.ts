import { TeamJoinRequestDirection } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import type { Bucket } from "@/lib/rateLimit";
import { teamTokenSchema, ticketTokenSchema } from "@/lib/validators";
import {
  resolveLeaderForUser,
  resolveRsvpByTicketToken,
  resolveTeamByManageToken,
  type TeamLeaderAuth,
  type TicketHolder,
} from "@/lib/core/teams";

/** Capability resolution, rate limits and audit shared by the team actions in app/actions/teams.ts. */

export const TOO_MANY = "Too many team changes. Please try again shortly.";
export const LINK_EXPIRED = "This team link is no longer valid. Use the newest link from your email.";
export const NOT_FOUND = "Registration not found.";

export const idSchema = z.string().trim().min(1).max(128);

const teamRefSchema = z.union([
  z.object({ manageToken: teamTokenSchema }).strict(),
  z.object({ teamId: idSchema }).strict(),
]);

type LeaderContext = { auth: TeamLeaderAuth; actorUserId: string | null };

export async function resolveLeader(ref: unknown): Promise<LeaderContext | null> {
  const parsed = teamRefSchema.safeParse(ref);
  if (!parsed.success) return null;
  const session = await auth();
  const actorUserId = session?.user?.id ?? null;
  if ("manageToken" in parsed.data) {
    const leader = await resolveTeamByManageToken(parsed.data.manageToken);
    return leader ? { auth: leader, actorUserId } : null;
  }
  // A bare team id is only an identifier: it resolves solely for the signed-in leader.
  if (!actorUserId) return null;
  const leader = await resolveLeaderForUser(actorUserId, parsed.data.teamId);
  return leader ? { auth: leader, actorUserId } : null;
}

export async function resolveHolder(ticketToken: unknown): Promise<{ holder: TicketHolder; token: string; actorUserId: string | null } | null> {
  const parsed = ticketTokenSchema.safeParse(ticketToken);
  if (!parsed.success) return null;
  const session = await auth();
  const actorUserId = session?.user?.id ?? null;
  // Account-owned registrations also need that account signed in (as for cancellation).
  const holder = await resolveRsvpByTicketToken(parsed.data, actorUserId);
  return holder ? { holder, token: parsed.data, actorUserId } : null;
}

export async function eventPaths(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: { organisationId: true, slug: true, organisation: { select: { slug: true } } },
  });
}

/** Audit plus revalidation of the public event page (capacity and counts can change). */
export async function afterTeamChange(params: {
  eventId: string;
  action: string;
  actorUserId: string | null;
  teamId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  const event = await eventPaths(params.eventId);
  if (!event) return;
  await recordAuditEvent({
    action: params.action,
    actorUserId: params.actorUserId,
    organisationId: event.organisationId,
    targetType: params.teamId ? "Team" : "Event",
    targetId: params.teamId ?? params.eventId,
    metadata: { eventId: params.eventId, ...params.metadata },
  }).catch(() => console.error("[teams] audit failed"));
  revalidatePath(`/${event.organisation.slug}/${event.slug}`);
}

export async function limited(bucket: Bucket, subject: string) {
  return isActionRateLimited(bucket, subject);
}

export const TOO_MANY_SEARCHES = "Too many searches. Try again shortly.";
export const LIST_UNAVAILABLE = "This list isn't available any more. Reload the page.";
export const directionSchema = z.enum([TeamJoinRequestDirection.INVITE, TeamJoinRequestDirection.REQUEST]);
