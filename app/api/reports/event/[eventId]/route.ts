import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { createEventReportPdf, getEventReportMetrics, reportFilename } from "@/lib/eventReport";
import { reportAccess } from "@/lib/eventReport/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function denied(status: 404 | 429 = 404) {
  return new Response(null, { status, headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", ...(status === 429 ? { "Retry-After": "600" } : {}) } });
}

type ReportRouteContext = { params: Promise<{ eventId: string }> };

export async function GET(_request: Request, context: ReportRouteContext) {
  const session = await auth();
  if (!session?.user?.id) return denied();

  const { eventId } = await context.params;
  // Allowance, ownership and availability first: the metrics read the whole event.
  const access = await reportAccess(session.user.id, { eventId });
  if (!access.ok) return denied(access.status);
  const metrics = await getEventReportMetrics(eventId);
  if (!metrics || metrics.organisationId !== access.organisationId) return denied();

  const pdf = await createEventReportPdf(metrics);
  await recordAuditEvent({ action: "EVENT_REPORT_DOWNLOADED", actorUserId: session.user.id, organisationId: metrics.organisationId, targetType: "Event", targetId: metrics.targetId });
  return new Response(pdf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${reportFilename(metrics)}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
