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
import { EventStatus, OrderStatus } from "@prisma/client";
import { peopleWithPlaces } from "@/lib/payments/eventCancellation";
import { noticeEach, noticeSubject, uniqueEmails } from "@/lib/notices";
import { queueOrganisationStorage } from "@/lib/storage/deletionQueue";

const revalidatePath = trackedRevalidation(nextRevalidatePath);

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

  const target = await getMembership(targetUserId, org.id);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role === "OWNER") {
    return { ok: false, error: "The owner role cannot be changed here." };
  }

  await prisma.membership.update({
    where: { id: target.id },
    data: { role },
  });
  await recordAuditEvent({
    action: "MEMBERSHIP_ROLE_CHANGED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "membership",
    targetId: target.id,
    metadata: { role },
  });

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

  const target = await getMembership(targetUserId, org.id);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role === "OWNER") {
    return { ok: false, error: "Cannot remove the organisation owner." };
  }
  if (actor.role === "ADMIN" && target.role !== "MEMBER") {
    return { ok: false, error: "Admins can only remove members." };
  }

  await prisma.membership.delete({ where: { id: target.id } });
  await recordAuditEvent({
    action: "MEMBER_REMOVED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "membership",
    targetId: target.id,
  });

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

  // Deleting would erase the tickets and payment records of people who paid
  // for something still to come: cancelling those events refunds them first.
  const now = new Date();
  const paidUpcoming = await prisma.order.count({
    where: {
      organisationId: org.id,
      totalMinor: { gt: 0 },
      status: { in: [OrderStatus.CONFIRMED, OrderStatus.PENDING, OrderStatus.REQUESTED] },
      OR: [{ event: { endDateTime: { gt: now }, status: { not: EventStatus.CANCELLED } } }, { series: { status: { not: EventStatus.CANCELLED }, instances: { some: { endDateTime: { gt: now }, cancelledAt: null } } } }],
    },
  });
  if (paidUpcoming > 0) {
    return { ok: false, error: "People have paid for upcoming events. Cancel those events (or their dates) first, which refunds them." };
  }

  const slug = org.slug;
  // Guests of upcoming events and dates are told they won't go ahead.
  await prisma.$transaction(async (tx) => {
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
  }, { timeout: 60_000 });
  // Deliberately omit organisationId: deleting the organisation cascades its
  // scoped records, while this event must survive as an instance-level record.
  await recordAuditEvent({
    action: "ORGANISATION_DELETED",
    actorUserId: session.user.id,
    targetType: "organisation",
    targetId: org.id,
  });
  // Its stored files are queued in the same transaction (lib/storage/deletionQueue.ts):
  // the queue has no foreign key, so it outlives the cascade, and the lock
  // orders this against an upload publishing its Asset.
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Organisation" WHERE "id" = ${org.id} FOR UPDATE`;
    await queueOrganisationStorage(tx, org.id);
    await tx.organisation.delete({ where: { id: org.id } });
  }, { timeout: 60_000 });

  revalidatePath("/dashboard");
  revalidatePath(`/${slug}`);
  return { ok: true };
}
