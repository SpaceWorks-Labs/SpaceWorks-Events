import { z } from "zod";
import { listRecentCheckIns, recentCheckInsCursorSchema, type RecentCheckInsPage } from "@/lib/checkInRecent";
import type { ActionResult } from "../org";
import { requireOrgMemberForEvent } from "./access";

const recentCheckInsSchema = z
  .object({
    organisationSlug: z.string().trim().min(1).max(200),
    eventId: z.string().trim().min(1).max(128),
    cursor: recentCheckInsCursorSchema,
  })
  .strict();

/** "Load more" on the desk's Recent check-ins: the same CHECK_IN access and rate limit as the desk. */
export async function loadRecentCheckIns(input: unknown): Promise<ActionResult<RecentCheckInsPage>> {
  const parsed = recentCheckInsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const ctx = await requireOrgMemberForEvent(parsed.data.organisationSlug, parsed.data.eventId);
  if (!ctx.ok) return { ok: false, error: ctx.error };
  return { ok: true, data: await listRecentCheckIns(ctx.event.id, parsed.data.cursor ?? null) };
}
