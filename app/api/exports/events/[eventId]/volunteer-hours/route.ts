import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { resolveOrganiserEvent } from "@/lib/core/teams";
import { csvStreamResponse, exportFilename, exportNotFound } from "@/lib/csvExport";
import { prisma } from "@/lib/db";
import { VOLUNTEER_HOURS_HEADER, volunteerHoursBatches } from "@/lib/volunteer/export";

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
  return csvStreamResponse({
    header: [...VOLUNTEER_HOURS_HEADER],
    filename: exportFilename("volunteer-hours", event.title),
    errorMessage: "Unable to export volunteer hours.",
    // Every sign-up, a page at a time. The audit counts the rows actually sent,
    // and records a stopped or failed download too (`complete: false`).
    batches: async function* batches() {
      let rows = 0;
      let complete = false;
      try {
        for await (const batch of volunteerHoursBatches(ctx.eventId)) {
          rows += batch.length;
          yield batch;
        }
        complete = true;
      } finally {
        await recordAuditEvent({ action: "VOLUNTEER_HOURS_EXPORTED", actorUserId: userId, organisationId: ctx.organisationId, targetType: "Event", targetId: ctx.eventId, metadata: { rows, complete } });
      }
    },
  });
}
