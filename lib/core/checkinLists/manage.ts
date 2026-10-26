import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/audit";
import {
  MAX_CHECK_IN_LISTS,
  createCheckInListSchema,
  reorderCheckInListsSchema,
  updateCheckInListSchema,
} from "@/lib/checkInLists";
import type { ActionResult } from "@/app/actions/org";
import { flattenZodErrors } from "@/app/actions/utils";
import { fail, resolveEvent, revalidateLists, type CheckInListSummary } from "./shared";

/** Managing an event's check-in lists: create, rename, archive, restore and reorder. */

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const toSummary = (list: CheckInListSummary): CheckInListSummary => ({
  id: list.id,
  name: list.name,
  sortOrder: list.sortOrder,
  archived: list.archived,
  requiresEntryCheckIn: list.requiresEntryCheckIn,
  addOn: list.addOn,
});

const summarySelect = { id: true, name: true, sortOrder: true, archived: true, requiresEntryCheckIn: true, addOn: { select: { id: true, name: true } } } as const;

export async function createCheckInListForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<CheckInListSummary>> {
  const parsed = createCheckInListSchema.safeParse(input);
  if (!parsed.success) return fail("Check the list name.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, name, requiresEntryCheckIn, addOnId } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "manage", "create");
  if (!ctx.ok) return ctx;

  try {
    const created = await prisma.$transaction(async (tx) => {
      // Serialise list creation per event so the cap and the next position hold.
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.event.id} FOR UPDATE`;
      const aggregate = await tx.checkInList.aggregate({ where: { eventId: ctx.event.id }, _count: { _all: true }, _max: { sortOrder: true } });
      if (aggregate._count._all >= MAX_CHECK_IN_LISTS) return null;
      // A paid extra (meal, swag, workshop) limits the list to its buyers.
      if (addOnId && !(await tx.addOn.findFirst({ where: { id: addOnId, eventId: ctx.event.id, archivedAt: null }, select: { id: true } }))) return "addOn" as const;
      const list = await tx.checkInList.create({
        data: { eventId: ctx.event.id, name, requiresEntryCheckIn: Boolean(requiresEntryCheckIn), addOnId: addOnId ?? null, sortOrder: (aggregate._max.sortOrder ?? -1) + 1 },
        select: summarySelect,
      });
      await recordAuditEvent({
        action: "CHECK_IN_LIST_CREATED",
        actorUserId: ctx.actorUserId,
        organisationId: ctx.org.id,
        targetType: "CheckInList",
        targetId: list.id,
        metadata: { eventId: ctx.event.id, requiresEntryCheckIn: list.requiresEntryCheckIn, addOn: Boolean(list.addOn) },
        client: tx,
      });
      return list;
    });
    if (!created) return fail(`An event can have up to ${MAX_CHECK_IN_LISTS} check-in lists.`);
    if (created === "addOn") return fail("Choose an extra this event sells.");
    revalidateLists(ctx.org.slug, ctx.event.id);
    return { ok: true, data: toSummary(created) };
  } catch (error) {
    if (isUniqueViolation(error)) return fail(`There is already a list called “${name}”.`, { fieldErrors: { name: ["Choose a different name."] } });
    throw error;
  }
}

export async function updateCheckInListForUser(actorUserId: string | null, input: unknown): Promise<ActionResult<CheckInListSummary>> {
  const parsed = updateCheckInListSchema.safeParse(input);
  if (!parsed.success) return fail("Check the list details.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, listId, name, requiresEntryCheckIn, archived } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "manage", "action");
  if (!ctx.ok) return ctx;

  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CheckInList" WHERE "id" = ${listId} FOR UPDATE`;
      const current = await tx.checkInList.findFirst({ where: { id: listId, eventId: ctx.event.id }, select: summarySelect });
      if (!current) return { kind: "error", error: "List not found." } as const;
      // An archived list is read-only: the only change it accepts is a restore.
      const staysArchived = current.archived && archived !== false;
      if (staysArchived && (name !== undefined || requiresEntryCheckIn !== undefined)) {
        return { kind: "error", error: "Restore this list before changing it." } as const;
      }
      const renamed = name !== undefined && name !== current.name;
      const archiveChanged = archived !== undefined && archived !== current.archived;
      const entryChanged = requiresEntryCheckIn !== undefined && requiresEntryCheckIn !== current.requiresEntryCheckIn;
      if (!renamed && !archiveChanged && !entryChanged) return { kind: "ok", list: current } as const;
      const list = await tx.checkInList.update({
        where: { id: current.id },
        data: {
          ...(renamed ? { name } : {}),
          ...(archiveChanged ? { archived } : {}),
          ...(entryChanged ? { requiresEntryCheckIn } : {}),
        },
        select: summarySelect,
      });
      const action = archiveChanged ? (list.archived ? "CHECK_IN_LIST_ARCHIVED" : "CHECK_IN_LIST_RESTORED") : renamed ? "CHECK_IN_LIST_RENAMED" : "CHECK_IN_LIST_UPDATED";
      await recordAuditEvent({
        action,
        actorUserId: ctx.actorUserId,
        organisationId: ctx.org.id,
        targetType: "CheckInList",
        targetId: list.id,
        metadata: { eventId: ctx.event.id, renamed, archived: list.archived, requiresEntryCheckIn: list.requiresEntryCheckIn },
        client: tx,
      });
      return { kind: "ok", list } as const;
    });
    if (result.kind === "error") return fail(result.error);
    revalidateLists(ctx.org.slug, ctx.event.id);
    return { ok: true, data: toSummary(result.list) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return fail(name ? `There is already a list called “${name}”.` : "Another open list already uses this name. Rename one of them first.", { fieldErrors: { name: ["Choose a different name."] } });
    }
    throw error;
  }
}

export async function reorderCheckInListsForUser(actorUserId: string | null, input: unknown): Promise<ActionResult> {
  const parsed = reorderCheckInListsSchema.safeParse(input);
  if (!parsed.success) return fail("Invalid list order.", { fieldErrors: flattenZodErrors(parsed.error) });
  const { organisationSlug, eventId, listIds } = parsed.data;
  const ctx = await resolveEvent(actorUserId, organisationSlug, eventId, "manage", "action");
  if (!ctx.ok) return ctx;

  const ok = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${ctx.event.id} FOR UPDATE`;
    const owned = await tx.checkInList.count({ where: { eventId: ctx.event.id, id: { in: listIds } } });
    if (owned !== listIds.length) return false;
    for (const [index, id] of listIds.entries()) {
      await tx.checkInList.update({ where: { id }, data: { sortOrder: index } });
    }
    await recordAuditEvent({
      action: "CHECK_IN_LISTS_REORDERED",
      actorUserId: ctx.actorUserId,
      organisationId: ctx.org.id,
      targetType: "Event",
      targetId: ctx.event.id,
      metadata: { lists: listIds.length },
      client: tx,
    });
    return true;
  });
  if (!ok) return fail("List not found.");
  revalidateLists(ctx.org.slug, ctx.event.id);
  return { ok: true };
}
