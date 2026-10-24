import "server-only";

/** Team registration email (docs/TEAMS.md): the leader's team page link and a member's own ticket. */

import { Prisma, type RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { sendTeamCreatedEmail, sendTeamMemberAddedEmail } from "@/lib/email";
import { hashTeamManageToken, isTeamTokenShape, teamJoinPath, teamManagePath } from "@/lib/teamToken";
import type { OutboxClient } from "./enqueue";
import { isBoundedString, isEmail } from "./payloads";

export const TEAM_CREATED_KIND = "team-created";
export const TEAM_MEMBER_ADDED_KIND = "team-member-added";

/**
 * Team page link for a (new) team leader. Carries the raw management token,
 * which exists nowhere else; the message is dropped if the team was deleted
 * or the token rotated before delivery. Team name and join link are read at
 * send time.
 */
export type TeamCreatedPayload = {
  to: string;
  teamId: string;
  manageToken: string;
  /** "created": a new team; "leader": leadership passed to this member. */
  reason?: "created" | "leader" | "reset";
};

/** A member the leader added: their own ticket link, resolved at send time from the token. */
export type TeamMemberAddedPayload = {
  to: string;
  checkInToken: string;
  addedByName?: string;
};

export async function enqueueTeamCreated(client: OutboxClient, payload: TeamCreatedPayload) {
  return client.outboxMessage.create({ data: { kind: TEAM_CREATED_KIND, payload: payload as Prisma.InputJsonValue } });
}

export async function enqueueTeamMemberAdded(client: OutboxClient, payload: TeamMemberAddedPayload) {
  return client.outboxMessage.create({ data: { kind: TEAM_MEMBER_ADDED_KIND, payload: payload as Prisma.InputJsonValue } });
}

export function asTeamCreatedPayload(value: Prisma.JsonValue): TeamCreatedPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.teamId, 64) ||
    !isTeamTokenShape(payload.manageToken) ||
    (payload.reason !== undefined && payload.reason !== "created" && payload.reason !== "leader" && payload.reason !== "reset")
  ) return null;
  return payload as TeamCreatedPayload;
}

export function asTeamMemberAddedPayload(value: Prisma.JsonValue): TeamMemberAddedPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    !isEmail(payload.to) ||
    !isBoundedString(payload.checkInToken, 128) ||
    (payload.addedByName !== undefined && !isBoundedString(payload.addedByName, 200))
  ) return null;
  return payload as TeamMemberAddedPayload;
}

export function isTeamMessageKind(kind: string) {
  return kind === TEAM_CREATED_KIND || kind === TEAM_MEMBER_ADDED_KIND;
}

/** The organisation a team message is sent as. */
export async function teamMessageOrganisation(kind: string, payload: Record<string, unknown>): Promise<string | null> {
  if (kind === TEAM_CREATED_KIND && typeof payload.teamId === "string") {
    return (await prisma.team.findUnique({ where: { id: payload.teamId }, select: { event: { select: { organisationId: true } } } }))?.event.organisationId ?? null;
  }
  if (kind === TEAM_MEMBER_ADDED_KIND && typeof payload.checkInToken === "string") {
    return (await prisma.rSVP.findUnique({ where: { checkInToken: payload.checkInToken }, select: { event: { select: { organisationId: true } } } }))?.event?.organisationId ?? null;
  }
  return null;
}

/**
 * Sends one team message. "dropped" means it no longer applies (the team was
 * deleted, its link regenerated, or the member left) and must not be retried.
 * Returns null for an invalid payload, which the worker treats as permanent.
 */
export async function deliverTeamMessage(kind: string, value: Prisma.JsonValue, messageId: string): Promise<"sent" | "dropped" | null> {
  if (kind === TEAM_CREATED_KIND) {
    const payload = asTeamCreatedPayload(value);
    if (!payload) return null;
    const team = await prisma.team.findUnique({
      where: { id: payload.teamId },
      select: {
        name: true,
        joinToken: true,
        manageTokenHash: true,
        event: { select: { title: true, slug: true, organisation: { select: { slug: true } } } },
        leaderRsvp: { select: { guestName: true, user: { select: { name: true } } } },
      },
    });
    // Never send a link that no longer works.
    if (!team || team.manageTokenHash !== hashTeamManageToken(payload.manageToken)) return "dropped";
    await sendTeamCreatedEmail({
      to: payload.to,
      eventTitle: team.event.title,
      teamName: team.name,
      managePath: teamManagePath(payload.manageToken),
      joinPath: teamJoinPath(team.event.organisation.slug, team.event.slug, team.joinToken),
      reason: payload.reason ?? "created",
      recipientName: team.leaderRsvp?.user?.name?.trim() || team.leaderRsvp?.guestName?.trim() || undefined,
      messageId,
    });
    return "sent";
  }
  const payload = asTeamMemberAddedPayload(value);
  if (!payload) return null;
  const rsvp = await prisma.rSVP.findUnique({
    where: { checkInToken: payload.checkInToken },
    select: { status: true, guestName: true, user: { select: { name: true } }, event: { select: { title: true } }, team: { select: { name: true } } },
  });
  if (!rsvp?.event || !rsvp.team) return "dropped";
  await sendTeamMemberAddedEmail({
    to: payload.to,
    eventTitle: rsvp.event.title,
    teamName: rsvp.team.name,
    status: rsvp.status as RsvpStatus,
    checkInToken: payload.checkInToken,
    addedByName: payload.addedByName,
    recipientName: rsvp.user?.name?.trim() || rsvp.guestName?.trim() || undefined,
    messageId,
  });
  return "sent";
}
