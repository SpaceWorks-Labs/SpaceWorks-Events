"use server";

import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  canDeleteOrg,
  canManageMembers,
  getMembership,
  isOrgAdmin,
} from "@/lib/permissions";
import {
  deleteOrganisationSchema,
  removeMemberSchema,
  updateMemberRoleSchema,
} from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { hasRecentAuthentication } from "@/lib/reauth";
import { EventStatus, type Prisma } from "@prisma/client";
import { peopleWithPlaces } from "@/lib/payments/eventCancellation";
import { organisationMoneyBlocker } from "@/lib/payments/obligations";
import { noticeEach, noticeSubject, uniqueEmails } from "@/lib/notices";
import { queueOrganisationStorage } from "@/lib/storage/deletionQueue";
import { retryOrganisationDeletion } from "@/lib/organisationDeletionRetry";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

/**
 * Membership changes run one at a time per organisation, on its row lock (as
 * leaving does), and re-read both people's roles under it: a promotion and a
 * removal can't both act on what they read before the other committed. FOR
 * NO KEY UPDATE serialises them without blocking the payment paths' key-share
 * fence (docs/PAYMENTS.md).
 */
async function lockMembers(tx: Prisma.TransactionClient, organisationId: string, actorUserId: string, targetUserId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Organisation" WHERE "id" = ${organisationId} FOR NO KEY UPDATE`;
  const [actor, target] = await Promise.all([
    tx.membership.findUnique({ where: { userId_organisationId: { userId: actorUserId, organisationId } }, select: { id: true, role: true } }),
    tx.membership.findUnique({ where: { userId_organisationId: { userId: targetUserId, organisationId } }, select: { id: true, role: true } }),
  ]);
  return { actor, target };
}

export async function updateMemberRole(
  input: unknown,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }

  const parsed = updateMemberRoleSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, targetUserId, role } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const actor = await getMembership(session.user.id, org.id);
  if (!canManageMembers(actor)) {
    return { ok: false, error: "Only the organisation owner can change roles." };
  }
  if (!(await hasRecentAuthentication())) {
    return { ok: false, error: "For security, sign in again before changing member roles." };
  }

  const actorUserId = session.user.id;
  const refusal = await prisma.$transaction(async (tx) => {
    const { actor: current, target } = await lockMembers(tx, org.id, actorUserId, targetUserId);
    if (current?.role !== "OWNER") return "Only the organisation owner can change roles.";
    if (!target) return "Member not found.";
    if (target.role === "OWNER") return "The owner role cannot be changed here.";
    const updated = await tx.membership.updateMany({ where: { id: target.id, organisationId: org.id, role: { not: "OWNER" } }, data: { role } });
    if (updated.count !== 1) return "Member not found.";
    await recordAuditEvent({
      action: "MEMBERSHIP_ROLE_CHANGED",
      actorUserId,
      organisationId: org.id,
      targetType: "membership",
      targetId: target.id,
      metadata: { role },
      client: tx,
    });
    return null;
  });
  if (refusal) return { ok: false, error: refusal };

  revalidatePath(`/dashboard/${org.slug}/members`);
  revalidatePath(`/dashboard/${org.slug}`);
  return { ok: true };
}

export async function removeMember(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }

  const parsed = removeMemberSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, targetUserId } = parsed.data;
  if (targetUserId === session.user.id) {
    return { ok: false, error: "You cannot remove yourself this way." };
  }

  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const actor = await getMembership(session.user.id, org.id);
  if (!actor || !isOrgAdmin(actor.role)) {
    return { ok: false, error: "You do not have permission to remove members." };
  }

  const actorUserId = session.user.id;
  const refusal = await prisma.$transaction(async (tx) => {
    const { actor: current, target } = await lockMembers(tx, org.id, actorUserId, targetUserId);
    if (!current || !isOrgAdmin(current.role)) return "You do not have permission to remove members.";
    if (!target) return "Member not found.";
    if (target.role === "OWNER") return "Cannot remove the organisation owner.";
    if (current.role === "ADMIN" && target.role !== "MEMBER") return "Admins can only remove members.";
    // Constrained to the role checked above, so a change committed meanwhile can't be swept away.
    const removed = await tx.membership.deleteMany({ where: { id: target.id, organisationId: org.id, role: current.role === "OWNER" ? { not: "OWNER" } : "MEMBER" } });
    if (removed.count !== 1) return "Member not found.";
    await recordAuditEvent({
      action: "MEMBER_REMOVED",
      actorUserId,
      organisationId: org.id,
      targetType: "membership",
      targetId: target.id,
      client: tx,
    });
    return null;
  });
  if (refusal) return { ok: false, error: refusal };

  revalidatePath(`/dashboard/${org.slug}/members`);
  revalidatePath(`/dashboard/${org.slug}`);
  return { ok: true };
}

export async function deleteOrganisation(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }

  const parsed = deleteOrganisationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const org = await prisma.organisation.findUnique({
    where: { slug: parsed.data.organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canDeleteOrg(membership)) {
    return { ok: false, error: "Only the organisation owner can delete it." };
  }
  if (!(await hasRecentAuthentication())) {
    return { ok: false, error: "For security, sign in again before deleting an organisation." };
  }

  const slug = org.slug;
  const actorUserId = session.user.id;
  // One transaction, the Organisation row first: every path that creates an
  // order or a payment takes its key-share fence (docs/PAYMENTS.md), so it
  // either committed before this check or waits and then finds nothing.
  // Other Event-locked commands can deadlock through an Organisation FK.
  // Retry the entire transaction, including obligations and queued effects;
  // nothing escapes an aborted attempt (docs/PAYMENTS.md).
  const refusal = await retryOrganisationDeletion(() => prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; }>>`SELECT "id" FROM "Organisation" WHERE "id" = ${org.id} FOR UPDATE`;
    if (locked.length === 0) return "Organisation not found.";
    const now = new Date();
    // Deleting would erase payment records and refunds still owed or in flight.
    const blocker = await organisationMoneyBlocker(tx, org.id, now);
    if (blocker) return blocker;
    // Guests of upcoming events and dates are told they won't go ahead.
    const [events, dates] = await Promise.all([
      tx.event.findMany({ where: { organisationId: org.id, status: EventStatus.PUBLISHED, endDateTime: { gt: now } }, select: { id: true, title: true } }),
      tx.eventInstance.findMany({ where: { series: { organisationId: org.id, status: EventStatus.PUBLISHED }, endDateTime: { gt: now }, cancelledAt: null }, select: { id: true, series: { select: { title: true } } } }),
    ]);
    // One email per person per event or series, however many dates they booked.
    const people = new Map<string, string[]>();
    for (const event of events) people.set(event.title, await peopleWithPlaces(tx, { eventId: event.id }));
    for (const date of dates) people.set(date.series.title, uniqueEmails([...(people.get(date.series.title) ?? []), ...(await peopleWithPlaces(tx, { eventInstanceId: date.id }))]));
    for (const [title, emails] of people) {
      await noticeEach(tx, emails, { subject: noticeSubject("Cancelled", title), lines: [`${title} has been cancelled: ${org.name} closed its account.`] });
    }
    // Deliberately omit organisationId: deleting the organisation cascades its
    // scoped records, while this event must survive as an instance-level record.
    await recordAuditEvent({ action: "ORGANISATION_DELETED", actorUserId, targetType: "organisation", targetId: org.id, client: tx });
    // Its stored files are queued here too (lib/storage/deletionQueue.ts): the
    // queue has no foreign key, so it outlives the cascade, and the row lock
    // orders this against an upload publishing its Asset.
    await queueOrganisationStorage(tx, org.id);
    await tx.organisation.delete({ where: { id: org.id } });
    return null;
  }, { timeout: 60_000 }));
  if (refusal) return { ok: false, error: refusal };

  revalidatePath("/dashboard");
  revalidatePath(`/${slug}`);
  return { ok: true };
}
