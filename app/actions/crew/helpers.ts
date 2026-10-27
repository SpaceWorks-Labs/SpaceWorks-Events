import "server-only";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { createSafeWebpDerivative } from "@/lib/imageValidation";
import { getPublicUrl, uploadFile } from "@/lib/storage";
import { resolveOrganiserEvent, type OrganiserEventContext } from "@/lib/core/teams";
import { CREW_PHOTO_CATEGORY, type OrganiserCrewContext } from "@/lib/core/crew";
import type { ActionResult } from "../org";
import { paths } from "../event-website/access";

/*
 * Shared parts of the crew Server Actions (docs/CREW.md). Organiser actions
 * need MANAGE_REGISTRATIONS (the guest-list rule, via resolveOrganiserEvent,
 * which also applies the staff authenticator check) and use the dashboard
 * "action" rate-limit budget; reordering or showing a whole crew is many
 * quick calls.
 */

export const NO_PERMISSION = "You do not have permission to manage the crew for this event.";
const MAX_CREW_PHOTO_BYTES = 5 * 1024 * 1024;

export const targetSchema = z.object({ organisationSlug: z.string().min(1).max(128), eventId: z.string().min(1).max(64) });
export const memberTargetSchema = targetSchema.extend({ memberId: z.string().min(1).max(64) });

type Gate<T> = { ok: true; event: OrganiserEventContext; crew: OrganiserCrewContext; data: T } | { ok: false; error: string };

export async function gate<S extends z.ZodType<z.infer<typeof targetSchema>>>(input: unknown, schema: S): Promise<Gate<z.infer<S>>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("action", userId)) return { ok: false, error: "Too many crew updates. Try again shortly." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const event = await resolveOrganiserEvent(userId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!event) return { ok: false, error: NO_PERMISSION };
  return { ok: true, event, crew: { organisationId: event.organisationId, eventId: event.eventId, actorUserId: userId }, data: parsed.data };
}

export function revalidateCrew(orgSlug: string, event: { id: string; slug: string }) {
  paths(orgSlug, event);
}

/** Audit metadata is ids only: never a crew member's email or a link token. */
export async function auditCrew(event: OrganiserEventContext, action: string, targetType: "EventCrewMember" | "Event", targetId: string) {
  await recordAuditEvent({ action, actorUserId: event.userId, organisationId: event.organisationId, targetType, targetId });
}

/** A crew photo through the safe WebP pipeline, under the organisation's event-crew prefix. */
export async function storeCrewPhoto(file: File, organisationId: string): Promise<ActionResult<{ url: string }>> {
  if (file.size === 0 || file.size > MAX_CREW_PHOTO_BYTES) return { ok: false, error: "Crew photos must be 5 MB or smaller." };
  try {
    const derivative = await createSafeWebpDerivative(file, { width: 1200, height: 1200, fit: "cover", position: "attention" });
    if ("error" in derivative) return { ok: false, error: derivative.error };
    const key = `organisations/${organisationId}/${CREW_PHOTO_CATEGORY}/${crypto.randomUUID()}.webp`;
    await uploadFile({ key, body: derivative.body, contentType: "image/webp", organisationId });
    return { ok: true, data: { url: getPublicUrl(key) } };
  } catch {
    return { ok: false, error: "Could not upload the photo." };
  }
}
