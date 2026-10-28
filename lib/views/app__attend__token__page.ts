import { notFound } from "next/navigation";
import { isAttendanceTokenShape } from "@/lib/attendanceToken";
import { parseAnswerPreselect } from "@/lib/attendanceCheck";
import { resolveAttendanceCheckByToken } from "@/lib/core/attendanceCheck";
import { isActionRateLimited } from "@/lib/actionRateLimit";

/**
 * "Are you still coming?" by its link (docs/ATTENDANCE.md). The link is the
 * only credential. A malformed, rotated or unknown token, or a released
 * registration, is a plain 404. Only this registration's own name, email and
 * answer; the stored digest is never read into the view.
 */
export async function loadAttendView({ params, searchParams }: { params: Promise<{ token: string; }>; searchParams: Promise<{ answer?: string | string[]; }>; }) {
  const [{ token }, query] = await Promise.all([params, searchParams]);
  const raw = token?.trim() ?? "";
  if (!isAttendanceTokenShape(raw)) notFound();
  // Per client address; a limited request is the same plain 404 as an unknown link.
  if (await isActionRateLimited("attendanceCheckView")) notFound();
  const view = await resolveAttendanceCheckByToken(raw);
  if (!view) notFound();
  return { view, token: raw, preselect: parseAnswerPreselect(query.answer) };
}
