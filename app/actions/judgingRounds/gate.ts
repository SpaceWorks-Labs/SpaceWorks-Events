import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { resolveJudgingOrganiser, type JudgingOrganiserContext } from "@/lib/judgingAccess";
import { projectGalleryPath, resultsPath } from "@/lib/submissionToken";

/*
 * The organiser gate for the Judging → Rounds actions (app/actions/judging-rounds.ts):
 * the same check as every judging management surface (organisation OWNER or
 * ADMIN through resolveJudgingOrganiser, which re-reads the event inside the
 * organisation), on a rate-limit bucket. Rules, locks and audits live in
 * lib/core/judgingRounds.ts.
 */

export const NO_PERMISSION = "You do not have permission to manage judging for this event.";

const scopeSchema = z.object({
  organisationSlug: z.string().trim().min(1).max(128),
  eventId: z.string().trim().min(1).max(128),
});

export type RoundsGate = { ok: true; ctx: JudgingOrganiserContext; input: Record<string, unknown> } | { ok: false; error: string };

export function record(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

export async function roundsGate(input: unknown, bucket: "action" | "broadcast" | "search" = "action"): Promise<RoundsGate> {
  const fields = record(input);
  const scope = scopeSchema.safeParse({ organisationSlug: fields.organisationSlug, eventId: fields.eventId });
  if (!scope.success) return { ok: false, error: "Invalid input." };
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited(bucket, userId)) return { ok: false, error: bucket === "search" ? "Too many requests. Try again shortly." : "Too many judging updates. Try again shortly." };
  const ctx = await resolveJudgingOrganiser(userId, scope.data.organisationSlug, scope.data.eventId);
  if (!ctx) return { ok: false, error: NO_PERMISSION };
  return { ok: true, ctx, input: fields };
}

/** The dashboard, the event page, and the public gallery and results pages (finalists show there). */
export function revalidateRounds(ctx: JudgingOrganiserContext) {
  revalidatePath(`/dashboard/${ctx.orgSlug}/event/${ctx.eventId}`);
  revalidatePath(`/${ctx.orgSlug}/${ctx.eventSlug}`);
  revalidatePath(projectGalleryPath(ctx.orgSlug, ctx.eventSlug));
  revalidatePath(resultsPath(ctx.orgSlug, ctx.eventSlug));
}
