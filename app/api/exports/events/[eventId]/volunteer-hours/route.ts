import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { resolveOrganiserEvent } from "@/lib/core/teams";
import { csvStreamResponse, exportFilename, exportNotFound } from "@/lib/csvExport";
import { prisma } from "@/lib/db";
import { VOLUNTEER_HOURS_HEADER, volunteerHoursRows } from "@/lib/volunteer/export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ eventId: string }> };

/**
 * Guests → Crew → Shifts → "Download hours CSV" (docs/VOLUNTEERS.md): one row
 * per sign-up with attendance and hours. The crew rule (OWNER/ADMIN or the
 * event's MANAGE_REGISTRATIONS grant, `resolveOrganiserEvent`); every denial
 * is the same empty 404. Names, never emails, tokens or reasons. Cells are
 * formula-neutralised by the CSV writer.
 */
export async function GET(_request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return exportNotFound();
  const { eventId } = await context.params;
  if (!eventId || eventId.length > 128) return exportNotFound();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, organisation: { select: { slug: true } } } });
  if (!event) return exportNotFound();
  const ctx = await resolveOrganiserEvent(userId, event.organisation.slug, event.id);
  if (!ctx) return exportNotFound();
  const rows = await volunteerHoursRows(ctx.eventId);
  await recordAuditEvent({ action: "VOLUNTEER_HOURS_EXPORTED", actorUserId: userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { rows: rows.length } });
  return csvStreamResponse({
    header: [...VOLUNTEER_HOURS_HEADER],
    filename: exportFilename("volunteer-hours", event.title),
    errorMessage: "Unable to export volunteer hours.",
    // One bounded batch: at most 200 shifts of at most 500 crew each, read above.
    batches: async function* batches() { yield rows; },
  });
}
