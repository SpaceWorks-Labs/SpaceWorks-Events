import { type Prisma, RsvpStatus } from "@prisma/client";
import { revalidatePath as nextRevalidatePath } from "next/cache";
import { trackedRevalidation } from "@/lib/frontend/revalidation";
import { z } from "zod";
import { CHECK_IN_LIST_SOURCES, MAX_CHECK_IN_LISTS } from "@/lib/checkInLists";

export const revalidatePath = trackedRevalidation(nextRevalidatePath);

export const UNDO_TTL_MS = 5 * 60_000;

export const snapshotSchema = z.object({
  eventId: z.string().min(1).nullable(),
  eventInstanceId: z.string().min(1).nullable(),
  userId: z.string().min(1).nullable(),
  guestEmail: z.string().email().nullable(),
  guestName: z.string().max(200).nullable(),
  status: z.nativeEnum(RsvpStatus),
  attendeeKey: z.string().min(1).max(512),
  checkInToken: z.string().min(8).max(256),
  checkedInAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  answers: z.array(z.object({
    fieldId: z.string().min(1),
    valueText: z.string().nullable(),
    valueBool: z.boolean().nullable(),
    valueNumber: z.number().finite().nullable(),
    valueDate: z.string().datetime().nullable(),
  })).max(200),
  /** Custom check-in list records, restored for lists that still belong to the event. */
  listCheckIns: z.array(z.object({
    listId: z.string().min(1).max(128),
    checkedInAt: z.string().datetime(),
    source: z.enum(CHECK_IN_LIST_SOURCES),
  })).max(MAX_CHECK_IN_LISTS).optional(),
}).refine(
  (value) => Boolean(value.eventId) !== Boolean(value.eventInstanceId),
  { message: "Invalid RSVP target." },
);

export function revalidateRsvpPaths(orgSlug: string, target: { eventId: string | null; eventInstanceId: string | null; eventSlug?: string; }) {
  revalidatePath(`/${orgSlug}`);
  revalidatePath(`/dashboard/${orgSlug}`);
  if (target.eventId) {
    revalidatePath(`/dashboard/${orgSlug}/event/${target.eventId}`);
    if (target.eventSlug) revalidatePath(`/${orgSlug}/${target.eventSlug}`);
  }
  if (target.eventInstanceId) revalidatePath(`/${orgSlug}/i/${target.eventInstanceId}`);
}

/** Puts back a restored RSVP's custom check-in list records, for lists still on the same event. History is not rewritten. */
export async function restoreListCheckIns(tx: Prisma.TransactionClient, eventId: string | null, rsvpId: string, listCheckIns: z.infer<typeof snapshotSchema>["listCheckIns"]) {
  if (!eventId || !listCheckIns?.length) return;
  const lists = await tx.checkInList.findMany({ where: { eventId, id: { in: listCheckIns.map((entry) => entry.listId) } }, select: { id: true } });
  const live = new Set(lists.map((list) => list.id));
  await tx.checkInListRecord.createMany({
    data: listCheckIns.filter((entry) => live.has(entry.listId)).map((entry) => ({
      listId: entry.listId,
      rsvpId,
      source: entry.source,
      checkedInAt: new Date(entry.checkedInAt),
    })),
    skipDuplicates: true,
  });
}
