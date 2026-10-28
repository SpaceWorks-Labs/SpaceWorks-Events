import "server-only";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { getMembership, isOrgAdmin } from "@/lib/permissions";
import { resolveOrganiserEvent, type OrganiserEventContext } from "@/lib/core/teams";
import type { VolunteerStaff } from "@/lib/volunteer/shared";
import { paths } from "../event-website/access";

/*
 * Shared parts of the volunteer shift Server Actions (docs/VOLUNTEERS.md).
 * Every organiser action needs the crew rule, MANAGE_REGISTRATIONS (via
 * resolveOrganiserEvent, which also applies the staff authenticator check);
 * hours verification and certificates also need organisation owner/admin,
 * which the cores re-check. Audit metadata is ids only: never names,
 * emails, reasons or certificate tokens.
 */

export const NO_PERMISSION = "You do not have permission to manage volunteer shifts for this event.";
export const targetSchema = z.object({ organisationSlug: z.string().min(1).max(128), eventId: z.string().min(1).max(64) });
export const id = z.string().min(1).max(64);

type Gate<T> = { ok: true; event: OrganiserEventContext; staff: VolunteerStaff; data: T } | { ok: false; error: string };

export async function gate<S extends z.ZodType<z.infer<typeof targetSchema>>>(input: unknown, schema: S): Promise<Gate<z.infer<S>>> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: "You must be signed in." };
  if (await isActionRateLimited("action", userId)) return { ok: false, error: "Too many shift updates. Try again shortly." };
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input." };
  const event = await resolveOrganiserEvent(userId, parsed.data.organisationSlug, parsed.data.eventId);
  if (!event) return { ok: false, error: NO_PERMISSION };
  const membership = await getMembership(userId, event.organisationId);
  const isAdmin = Boolean(membership && isOrgAdmin(membership.role));
  return { ok: true, event, staff: { organisationId: event.organisationId, eventId: event.eventId, userId, isAdmin }, data: parsed.data };
}

export async function audit(event: OrganiserEventContext, action: string, targetType: string, targetId: string) {
  await recordAuditEvent({ action, actorUserId: event.userId, organisationId: event.organisationId, targetType, targetId });
}

export function revalidate(event: OrganiserEventContext) {
  paths(event.orgSlug, { id: event.eventId, slug: event.eventSlug });
}
