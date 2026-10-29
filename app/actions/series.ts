"use server";

import { EventStatus } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { buildRecurrenceIcs, materializeInstances } from "@/lib/recurrence";
import { canCreateEvent, canManageEvents, getMembership, isUserEmailVerified } from "@/lib/permissions";
import { slugifyTitle, withSlugSuffix } from "@/lib/slug";
import {
  createSeriesSchema,
  deleteSeriesSchema,
  updateSeriesMetaSchema,
} from "@/lib/validators";
import type { ActionResult } from "./org";
import { flattenZodErrors } from "./utils";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { hasPaidOrders, PAID_SERIES_REFUSAL, peopleWithPlaces } from "@/lib/payments/eventCancellation";
import { fenceOrganisation } from "@/lib/payments/targets";
import { noticeEach, noticeSubject, uniqueEmails } from "@/lib/notices";
import { cancelOccurrence, setOccurrenceCapacity } from "@/lib/payments/occurrences";
import { PaymentOperationError } from "@/lib/payments/operations";
import { seatTakingWhere } from "@/lib/payments/holds";
import { cancelDateSchema, capacitySchema, dateAccess, revalidateAllSeriesPaths, revalidatePath } from "./series/helpers";

export async function createEventSeries(
  input: unknown,
): Promise<ActionResult<{ id: string; }>> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (!(await isUserEmailVerified(session.user.id))) {
    return { ok: false, error: "Verify your email before creating event series." };
  }
  if (await isActionRateLimited("create", session.user.id)) {
    return { ok: false, error: "Too many creation attempts. Please try again later." };
  }

  const parsed = createSeriesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const data = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: data.organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canCreateEvent(membership)) {
    return {
      ok: false,
      error: "Only owners and admins can create event series.",
    };
  }

  const baseSlug = slugifyTitle(data.title);
  let slug = baseSlug;
  let attempt = 0;
  while (
    await prisma.eventSeries.findUnique({
      where: { organisationId_slug: { organisationId: org.id, slug } },
    })
  ) {
    attempt += 1;
    if (attempt > 50) {
      return { ok: false, error: "Could not generate a unique URL slug." };
    }
    slug = withSlugSuffix(baseSlug, attempt);
  }

  const durationMs =
    data.anchorEndDateTime.getTime() - data.anchorStartDateTime.getTime();
  if (durationMs <= 0) {
    return { ok: false, error: "Invalid duration." };
  }

  const ics = buildRecurrenceIcs(data.anchorStartDateTime, data.rruleLine);
  const windows = materializeInstances(ics, durationMs, { timeZone: data.timezone });
  if (windows.length === 0) {
    return {
      ok: false,
      error: "Could not expand recurrence — check the rule (include FREQ=…).",
    };
  }

  try {
    const series = await prisma.$transaction(async (tx) => {
      const s = await tx.eventSeries.create({
        data: {
          organisationId: org.id,
          title: data.title,
          slug,
          description: data.description ?? "",
          recurrenceRule: ics,
          instanceDurationMs: durationMs,
          timezone: data.timezone,
          privacyType: data.privacyType,
          capacity: data.capacity ?? null,
          status: data.status ?? EventStatus.DRAFT,
        },
      });
      await tx.eventInstance.createMany({
        data: windows.map((w) => ({
          eventSeriesId: s.id,
          startDateTime: w.startDateTime,
          endDateTime: w.endDateTime,
        })),
      });
      return s;
    });

    const instances = await prisma.eventInstance.findMany({
      where: { eventSeriesId: series.id },
      select: { id: true },
    });
    await recordAuditEvent({
      action: "EVENT_SERIES_CREATED",
      actorUserId: session.user.id,
      organisationId: org.id,
      targetType: "EventSeries",
      targetId: series.id,
      metadata: { instances: instances.length, status: series.status },
    });
    revalidateAllSeriesPaths(
      org.slug,
      series.id,
      instances.map((i) => i.id),
    );
    return { ok: true, data: { id: series.id } };
  } catch {
    console.error("[series] creation failed");
    return { ok: false, error: "Could not create event series." };
  }
}

export async function updateEventSeriesMeta(
  input: unknown,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many updates. Please try again later." };

  const parsed = updateSeriesMetaSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const data = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: data.organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canManageEvents(membership)) {
    return { ok: false, error: "You do not have permission to edit this series." };
  }

  const series = await prisma.eventSeries.findFirst({
    where: { id: data.eventSeriesId, organisationId: org.id },
  });
  if (!series) return { ok: false, error: "Series not found." };

  const saved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${series.id} FOR UPDATE`;
    if (data.capacity != null) {
      // Taken seats (confirmed, and paid holds still live), counted under the
      // series lock every reservation takes first, with the time read after it.
      const counts = await tx.rSVP.groupBy({
        by: ["eventInstanceId"],
        // Dates with their own capacity aren't bound by the series one.
        where: { eventInstance: { eventSeriesId: series.id, capacity: null }, ...seatTakingWhere(new Date()) },
        _count: { _all: true },
      });
      if (counts.some((row) => row._count._all > data.capacity!)) return false;
    }
    await tx.eventSeries.update({
      where: { id: series.id },
      data: {
        title: data.title,
        description: data.description ?? "",
        timezone: data.timezone,
        capacity: data.capacity ?? null,
        status: data.status,
        privacyType: data.privacyType,
      },
    });
    return true;
  });
  if (!saved) return { ok: false, error: "Capacity cannot be lower than the places already taken (or being paid for) on an occurrence." };

  // Cancelling the series cancels each upcoming date: refunds, and an email to everyone on it.
  if (data.status === EventStatus.CANCELLED && series.status !== EventStatus.CANCELLED) {
    const upcoming = await prisma.eventInstance.findMany({ where: { eventSeriesId: series.id, endDateTime: { gt: new Date() }, cancelledAt: null }, select: { id: true }, orderBy: { startDateTime: "asc" } });
    for (const date of upcoming) {
      await cancelOccurrence({ organisationId: org.id, seriesId: series.id, instanceId: date.id, actorUserId: session.user.id, reason: "The series was cancelled." }).catch((error: unknown) => {
        if (!(error instanceof PaymentOperationError)) throw error;
      });
    }
  }

  await recordAuditEvent({
    action: "EVENT_SERIES_UPDATED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "EventSeries",
    targetId: series.id,
    metadata: { status: data.status },
  });

  const instances = await prisma.eventInstance.findMany({
    where: { eventSeriesId: series.id },
    select: { id: true },
  });
  revalidateAllSeriesPaths(
    org.slug,
    series.id,
    instances.map((i) => i.id),
  );
  return { ok: true };
}

export async function deleteEventSeries(input: unknown): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, error: "You must be signed in." };
  }
  if (await isActionRateLimited("action", session.user.id)) return { ok: false, error: "Too many updates. Please try again later." };

  const parsed = deleteSeriesSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Invalid input.",
      fieldErrors: flattenZodErrors(parsed.error),
    };
  }

  const { organisationSlug, eventSeriesId } = parsed.data;
  const org = await prisma.organisation.findUnique({
    where: { slug: organisationSlug },
  });
  if (!org) return { ok: false, error: "Organisation not found." };

  const membership = await getMembership(session.user.id, org.id);
  if (!canManageEvents(membership)) {
    return { ok: false, error: "You do not have permission to delete this series." };
  }

  const series = await prisma.eventSeries.findFirst({
    where: { id: eventSeriesId, organisationId: org.id },
  });
  if (!series) return { ok: false, error: "Series not found." };

  // Deleting would erase the tickets of people who paid: cancel dates instead,
  // which refunds them.
  if (await hasPaidOrders({ eventSeriesId: series.id })) return { ok: false, error: PAID_SERIES_REFUSAL };

  const instances = await prisma.eventInstance.findMany({
    where: { eventSeriesId: series.id },
    select: { id: true },
  });

  const refused = await prisma.$transaction(async (tx) => {
    // The locks a reservation takes first (docs/PAYMENTS.md): the organisation
    // fence, then the series row. A paid order committed before this is seen
    // here; one that waits finds the series gone.
    await fenceOrganisation(tx, org.id);
    await tx.$queryRaw`SELECT "id" FROM "EventSeries" WHERE "id" = ${series.id} FOR UPDATE`;
    if (await hasPaidOrders({ eventSeriesId: series.id }, tx)) return true;
    // People booked on upcoming dates are told the series won't go ahead.
    if (series.status === EventStatus.PUBLISHED) {
      const upcoming = await tx.eventInstance.findMany({ where: { eventSeriesId: series.id, endDateTime: { gt: new Date() }, cancelledAt: null }, select: { id: true } });
      const people = uniqueEmails((await Promise.all(upcoming.map((date) => peopleWithPlaces(tx, { eventInstanceId: date.id })))).flat());
      await noticeEach(tx, people, { organisationId: org.id, subject: noticeSubject("Cancelled", series.title), lines: [`${series.title} has been cancelled by the organiser, with all its upcoming dates.`] });
    }
    await tx.eventSeries.delete({ where: { id: series.id } });
    return false;
  });
  if (refused) return { ok: false, error: PAID_SERIES_REFUSAL };

  await recordAuditEvent({
    action: "EVENT_SERIES_DELETED",
    actorUserId: session.user.id,
    organisationId: org.id,
    targetType: "EventSeries",
    targetId: series.id,
  });

  revalidatePath(`/dashboard/${org.slug}`);
  revalidatePath(`/${org.slug}`);
  for (const i of instances) {
    revalidatePath(`/${org.slug}/i/${i.id}`);
  }
  return { ok: true };
}

/** One date's own capacity, or null to use the series capacity. */
export async function setSeriesDateCapacity(input: unknown): Promise<ActionResult> {
  const parsed = capacitySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Enter a capacity of at least 1, or leave it blank." };
  const access = await dateAccess(parsed.data.organisationSlug);
  if ("error" in access) return { ok: false, error: access.error ?? "Organisation not found." };
  try {
    await setOccurrenceCapacity({ organisationId: access.org.id, seriesId: parsed.data.eventSeriesId, instanceId: parsed.data.instanceId, capacity: parsed.data.capacity, actorUserId: access.userId });
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message };
    throw error;
  }
  revalidateAllSeriesPaths(access.org.slug, parsed.data.eventSeriesId, [parsed.data.instanceId]);
  return { ok: true };
}

/** Cancel one date: its orders are refunded (a pass, its share) and everyone on it is emailed. */
export async function cancelSeriesDate(input: unknown): Promise<ActionResult<{ refunded: number; failed: number; notified: number; }>> {
  const parsed = cancelDateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Choose a date to cancel." };
  const access = await dateAccess(parsed.data.organisationSlug);
  if ("error" in access) return { ok: false, error: access.error ?? "Organisation not found." };
  try {
    const result = await cancelOccurrence({ organisationId: access.org.id, seriesId: parsed.data.eventSeriesId, instanceId: parsed.data.instanceId, actorUserId: access.userId, reason: parsed.data.reason });
    revalidateAllSeriesPaths(access.org.slug, parsed.data.eventSeriesId, [parsed.data.instanceId]);
    return { ok: true, data: { refunded: result.refunded, failed: result.failed, notified: result.notified } };
  } catch (error) {
    if (error instanceof PaymentOperationError) return { ok: false, error: error.message };
    throw error;
  }
}
