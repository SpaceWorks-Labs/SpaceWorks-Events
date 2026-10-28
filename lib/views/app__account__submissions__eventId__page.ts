import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/permissions";
import { resolveEntrantForUser } from "@/lib/core/judging";
import { loadSubmissionEditorView } from "@/lib/submissionEditorView";

/**
 * A signed-in entrant's project page: any member of a team (the team's shared
 * submission) or the owner of a solo registration. The event id alone grants
 * nothing; anything else is a plain 404.
 */
export async function loadAccountSubmissionView({ params }: { params: Promise<{ eventId: string; }>; }) {
  const session = await requireAuth();
  const { eventId } = await params;
  const entrant = await resolveEntrantForUser(session.user.id, eventId);
  if (!entrant) notFound();
  const view = await loadSubmissionEditorView(entrant);
  if (!view) notFound();
  return { view, eventId: entrant.eventId };
}
