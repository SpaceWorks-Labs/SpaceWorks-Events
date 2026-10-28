import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { resolveDeskOrganiser } from "@/lib/core/mentorDesk/access";
import { mentorDeskExportBatches, MENTOR_DESK_EXPORT_HEADERS, parseMentorDeskExportView } from "@/lib/core/mentorDesk/export";
import { csvStreamResponse, exportFilename, exportNotFound } from "@/lib/csvExport";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/*
 * Mentor Desk CSVs (docs/MENTOR_DESK.md): organisation OWNER/ADMIN only;
 * anyone else, and any malformed parameter, gets the same bare 404.
 * `view=requests` (default) lists help requests without their text or any
 * contact details; `view=assignments` lists mentor-team mappings. Every cell
 * goes through buildCsv, which neutralises spreadsheet formulas.
 */

type RouteContext = { params: Promise<{ eventId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return exportNotFound();
  const { eventId } = await context.params;
  if (!eventId || eventId.length > 128) return exportNotFound();
  const view = parseMentorDeskExportView(new URL(request.url).searchParams);
  if (!view) return exportNotFound();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, timezone: true, organisation: { select: { slug: true } } } });
  if (!event) return exportNotFound();
  const ctx = await resolveDeskOrganiser(userId, event.organisation.slug, event.id);
  if (!ctx) return exportNotFound();
  await recordAuditEvent({ action: "MENTOR_DESK_EXPORTED", actorUserId: userId, organisationId: ctx.organisationId, targetType: "Event", targetId: event.id, metadata: { view } });
  return csvStreamResponse({
    header: MENTOR_DESK_EXPORT_HEADERS[view],
    batches: () => mentorDeskExportBatches(event.id, event.timezone, view),
    filename: exportFilename(view === "requests" ? "help-requests" : "mentor-assignments", event.title),
    errorMessage: "Mentor Desk export failed",
  });
}
