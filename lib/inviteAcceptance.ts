import "server-only";

import { prisma } from "@/lib/db";
import { hashEventCollaboratorToken } from "@/lib/eventCollaboratorToken";
import { linkCrewAccount } from "@/lib/core/crew/shared";
import { syncMentorGrantLocked } from "@/lib/core/mentorDesk/grant";
import { lockMentorGrantPersons } from "@/lib/core/mentorDesk/crewLink";
import { DeskError } from "@/lib/core/mentorDesk/shared";
import { emitWebhookEvent, type WebhookEmission } from "@/lib/webhooks/emit";

export type InviteAcceptance =
  | { ok: true; href: string }
  | { ok: false; reason: "unavailable" | "wrong-account"; error?: string };

export async function acceptOrganisationInviteToken(token: string, userId: string): Promise<InviteAcceptance> {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.organisationInvite.findUnique({
      where: { token },
      select: { id: true, role: true, organisationId: true, usedAt: true, expiresAt: true, organisation: { select: { slug: true } } },
    });
    const now = new Date();
    if (!invite || invite.usedAt || (invite.expiresAt && invite.expiresAt <= now)) return { ok: false, reason: "unavailable" };
    const claim = await tx.organisationInvite.updateMany({
      where: { id: invite.id, usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      data: { usedAt: now, usedByUserId: userId },
    });
    if (claim.count !== 1) return { ok: false, reason: "unavailable" };
    await tx.membership.upsert({
      where: { userId_organisationId: { userId, organisationId: invite.organisationId } },
      create: { userId, organisationId: invite.organisationId, role: invite.role },
      update: {},
    });
    await tx.auditEvent.create({ data: { action: "ORGANISATION_INVITE_ACCEPTED", actorUserId: userId, organisationId: invite.organisationId, targetType: "OrganisationInvite", targetId: invite.id } });
    return { ok: true, href: `/dashboard/${invite.organisation.slug}` };
  });
}

export async function acceptEventCollaboratorInviteToken(token: string, user: { id: string; email: string }): Promise<InviteAcceptance> {
  const tokenHash = hashEventCollaboratorToken(token);
  let webhook: WebhookEmission | null = null;
  const result = await prisma.$transaction<InviteAcceptance>(async (tx) => {
    const invite = await tx.eventCollaboratorInvite.findUnique({
      where: { tokenHash },
      select: {
        id: true, email: true, eventId: true, eventSeriesId: true, permissions: true, usedAt: true, expiresAt: true,
        event: { select: { organisation: { select: { id: true, slug: true } } } },
        series: { select: { organisation: { select: { id: true, slug: true } } } },
      },
    });
    const now = new Date();
    if (!invite || invite.usedAt || invite.expiresAt <= now) return { ok: false, reason: "unavailable" };
    if (invite.email.trim().toLowerCase() !== user.email.trim().toLowerCase()) return { ok: false, reason: "wrong-account" };
    const organisation = invite.event?.organisation ?? invite.series?.organisation;
    if (!organisation) return { ok: false, reason: "unavailable" };
    await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organisation.id} FOR KEY SHARE`;
    // The target precedes the invite claim: deletion holds it before cascading to the invite.
    // Exclusive for an event because account linking below also takes the Event lock.
    const target = invite.eventId
      ? await tx.$queryRaw<unknown[]>`SELECT "id" FROM "Event" WHERE "id" = ${invite.eventId} FOR UPDATE`
      : await tx.$queryRaw<unknown[]>`SELECT "id" FROM "EventSeries" WHERE "id" = ${invite.eventSeriesId} FOR KEY SHARE`;
    if (target.length !== 1) return { ok: false, reason: "unavailable" };
    const claim = await tx.eventCollaboratorInvite.updateMany({
      where: { id: invite.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now, usedByUserId: user.id },
    });
    if (claim.count !== 1) return { ok: false, reason: "unavailable" };
    if (invite.eventId) {
      // Link before taking the grant: Event -> people -> crew, with existing duties rechecked.
      await lockMentorGrantPersons(tx, invite.eventId, user.id);
      await linkCrewAccount(tx, user.id, invite.email, invite.eventId);
      await tx.$queryRaw`SELECT "id" FROM "EventCollaborator" WHERE "eventId" = ${invite.eventId} AND "userId" = ${user.id} FOR UPDATE`;
      const before = await tx.eventCollaborator.findUnique({ where: { eventId_userId: { eventId: invite.eventId, userId: user.id } }, select: { permissions: true } });
      await tx.eventCollaborator.upsert({
        where: { eventId_userId: { eventId: invite.eventId, userId: user.id } },
        create: { eventId: invite.eventId, userId: user.id, permissions: invite.permissions },
        update: { permissions: invite.permissions },
      });
      // A MENTOR grant gets its Mentor Desk profile (docs/MENTOR_DESK.md); it never creates an order.
      webhook = await syncMentorGrantLocked(tx, invite.eventId, user.id, before?.permissions ?? [], invite.permissions, user.id);
    } else if (invite.eventSeriesId) {
      await tx.eventCollaborator.upsert({
        where: { eventSeriesId_userId: { eventSeriesId: invite.eventSeriesId, userId: user.id } },
        create: { eventSeriesId: invite.eventSeriesId, userId: user.id, permissions: invite.permissions },
        update: { permissions: invite.permissions },
      });
    } else {
      throw new Error("Collaborator invite has no target.");
    }
    await tx.auditEvent.create({ data: { action: "EVENT_COLLABORATOR_INVITE_ACCEPTED", actorUserId: user.id, organisationId: organisation.id, targetType: "EventCollaboratorInvite", targetId: invite.id } });
    const href = invite.eventId ? `/dashboard/${organisation.slug}/event/${invite.eventId}` : `/dashboard/${organisation.slug}/series/${invite.eventSeriesId}`;
    return { ok: true, href };
  }).catch((error) => {
    if (error instanceof DeskError) return { ok: false as const, reason: "unavailable" as const, error: error.message };
    throw error;
  });
  if (result.ok && webhook) emitWebhookEvent(webhook);
  return result;
}
