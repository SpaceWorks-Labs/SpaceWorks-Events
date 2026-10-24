import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/permissions";
import { resolveLeaderForUser } from "@/lib/core/teams";
import { loadTeamPageData } from "@/lib/teamPageData";

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
  return { data, teamRef: { teamId: leader.teamId } };
}
