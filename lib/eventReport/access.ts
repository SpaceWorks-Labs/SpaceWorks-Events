import "server-only";

import { prisma } from "@/lib/db";
import { isActionRateLimited } from "@/lib/actionRateLimit";
import { isReportAvailable } from "@/lib/eventReport";
import { getMembership, isOrgAdmin } from "@/lib/permissions";

export type ReportAccess = { ok: true; organisationId: string; } | { ok: false; status: 404 | 429; };

/**
 * Whether this account may download the report of an event or of one series
 * date, decided before any metrics load (they read every registration and
 * feedback answer): within the per-account report allowance, an owner or
 * admin of the organisation, once the event or date has ended. Anything
 * else is the same 404, so a report never reveals that an event exists.
 */
export async function reportAccess(userId: string, target: { eventId: string; } | { instanceId: string; }): Promise<ReportAccess> {
  if (await isActionRateLimited("report", userId)) return { ok: false, status: 429 };
  const owner = "eventId" in target
    ? await prisma.event.findUnique({ where: { id: target.eventId }, select: { organisationId: true, endDateTime: true } })
    : await prisma.eventInstance.findUnique({ where: { id: target.instanceId }, select: { endDateTime: true, series: { select: { organisationId: true } } } })
      .then((date) => date && { organisationId: date.series.organisationId, endDateTime: date.endDateTime });
  if (!owner) return { ok: false, status: 404 };
  const membership = await getMembership(userId, owner.organisationId);
  if (!membership || !isOrgAdmin(membership.role) || !isReportAvailable(owner.endDateTime)) return { ok: false, status: 404 };
  return { ok: true, organisationId: owner.organisationId };
}
