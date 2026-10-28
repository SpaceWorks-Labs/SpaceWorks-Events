import "server-only";

import { prisma } from "@/lib/db";
import { deleteFiles } from "@/lib/storage";
import { CREW_PHOTO_CATEGORY } from "./shared";

/**
 * Crew photos (docs/CREW.md) are uploaded before the crew form is saved, from
 * the dashboard or the public sign-up link. One no crew member points at
 * after a day (an abandoned sign-up, a replaced or removed photo) is deleted
 * by the retention pass. Deleting is idempotent, so two passes at once are
 * safe.
 */
export const UNUSED_CREW_PHOTO_MS = 24 * 60 * 60_000;
const BATCH = 200;

export async function purgeUnusedCrewPhotos(now = new Date(), limit = 1000) {
  const before = new Date(now.getTime() - UNUSED_CREW_PHOTO_MS);
  let purged = 0;
  let cursor: string | undefined;
  while (purged < limit) {
    const assets = await prisma.asset.findMany({
      // A plain id cursor: the previous batch's rows may have been deleted.
      where: { key: { startsWith: "organisations/", contains: `/${CREW_PHOTO_CATEGORY}/` }, createdAt: { lt: before }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: "asc" },
      take: BATCH,
      select: { id: true, key: true },
    });
    if (assets.length === 0) break;
    cursor = assets.at(-1)!.id;
    // Stored photo URLs end in `/api/uploads/<key>` (site-relative or absolute).
    const used = await prisma.eventCrewMember.findMany({
      where: { OR: assets.map((asset) => ({ photoUrl: { endsWith: `/api/uploads/${asset.key}` } })) },
      select: { photoUrl: true },
    });
    const unused = assets.filter((asset) => !used.some((member) => member.photoUrl?.endsWith(`/api/uploads/${asset.key}`))).map((asset) => asset.key);
    if (unused.length > 0) {
      await deleteFiles(unused);
      purged += unused.length;
    }
  }
  return purged;
}
