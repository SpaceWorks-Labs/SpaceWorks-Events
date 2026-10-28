import { auth } from "@/lib/auth";
import { recordAuditEvent } from "@/lib/audit";
import { buildAccountDataExport, loadAccountExportSource } from "@/lib/accountDataExport";
import { loadAccountApplications } from "@/lib/admission/accountExport";
import { buildParticipationExport, loadParticipationSource } from "@/lib/accountDataExport/participation";
import { checkRateLimitById } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function empty(status: number, extra: Record<string, string> = {}) {
  return new Response(null, { status, headers: { ...privateHeaders, ...extra } });
}

/**
 * Personal data export: the signed-in user's own profile, memberships,
 * registrations, feedback, collaborator roles, applications and participation
 * (crew, claims, volunteering, Mentor Desk, team finding, prize payouts) as a
 * JSON download. The user
 * is resolved solely from the session; no request input selects whose data.
 */
export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return empty(401);

  // Keyed on the user, not the IP: deployments without a trusted proxy header
  // share one "unknown" IP and must not throttle every account together.
  if (!(await checkRateLimitById("dataExport", `user:${userId}`))) {
    return empty(429, { "Retry-After": "3600" });
  }

  const source = await loadAccountExportSource(userId);
  if (!source) return empty(401);

  await recordAuditEvent({
    action: "ACCOUNT_DATA_EXPORTED",
    actorUserId: userId,
    targetType: "User",
    targetId: userId,
  });

  const generatedAt = new Date();
  // Applications (docs/ADMISSION.md): status, stage and the account's own answers; never reviews.
  const [applications, participation] = await Promise.all([loadAccountApplications(userId), loadParticipationSource(userId)]);
  const body = JSON.stringify({ ...buildAccountDataExport(source, generatedAt), applications, ...buildParticipationExport(participation) }, null, 2);
  return new Response(body, {
    headers: {
      ...privateHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="space-works-events-account-data-${generatedAt.toISOString().slice(0, 10)}.json"`,
    },
  });
}
