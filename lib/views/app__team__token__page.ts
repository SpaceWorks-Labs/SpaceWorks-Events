import { notFound } from "next/navigation";
import { resolveTeamByManageToken } from "@/lib/core/teams";
import { isTeamTokenShape } from "@/lib/teamToken";
import { loadTeamPageData } from "@/lib/teamPageData";
import { resolveEntrantByTeamManageToken } from "@/lib/core/judging";
import { loadSubmissionEditorView } from "@/lib/submissionEditorView";
import { resolveParticipantByManageToken } from "@/lib/core/mentorDesk/access";
import { loadParticipantDesk } from "@/lib/core/mentorDesk/readsParticipant";

/** The leader's team page by management token, a bearer capability: unknown or retired tokens are a plain 404. */
export async function loadTeamManageView({ params }: { params: Promise<{ token: string; }>; }) {
  const { token } = await params;
  const raw = token?.trim() ?? "";
  if (!isTeamTokenShape(raw)) notFound();
  const leader = await resolveTeamByManageToken(raw);
  if (!leader) notFound();
  const data = await loadTeamPageData(leader);
  if (!data) notFound();
  // The same management link edits the team's hackathon submission (docs/HACKATHON.md).
  const entrant = await resolveEntrantByTeamManageToken(raw);
  const submission = entrant ? await loadSubmissionEditorView(entrant) : null;
  // The same link raises help and books office hours when the Mentor Desk is on (docs/MENTOR_DESK.md).
  const participant = await resolveParticipantByManageToken(raw);
  const mentorDesk = participant ? await loadParticipantDesk(participant) : null;
  return { data, teamRef: { manageToken: raw }, submission, mentorDesk };
}
