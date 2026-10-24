import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/permissions";
import { resolveLeaderForUser } from "@/lib/core/teams";
import { loadTeamPageData } from "@/lib/teamPageData";
import { resolveEntrantForUser } from "@/lib/core/judging";
import { loadSubmissionEditorView } from "@/lib/submissionEditorView";

/**
 * A signed-in leader's team page. The team id alone grants nothing: it
 * resolves only while this account owns the team's leader registration.
 */
export async function loadAccountTeamView({ params }: { params: Promise<{ teamId: string; }>; }) {
  const session = await requireAuth();
  const { teamId } = await params;
  const leader = await resolveLeaderForUser(session.user.id, teamId);
  if (!leader) notFound();
  const data = await loadTeamPageData(leader);
  if (!data) notFound();
  // The signed-in leader edits the team's submission as a member of the team (docs/HACKATHON.md).
  const entrant = await resolveEntrantForUser(session.user.id, leader.eventId);
  const submission = entrant ? await loadSubmissionEditorView(entrant) : null;
  return { data, teamRef: { teamId: leader.teamId }, submission, eventId: leader.eventId };
}
