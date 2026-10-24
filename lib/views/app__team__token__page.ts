import { notFound } from "next/navigation";
import { resolveTeamByManageToken } from "@/lib/core/teams";
import { isTeamTokenShape } from "@/lib/teamToken";
import { loadTeamPageData } from "@/lib/teamPageData";

/** The leader's team page by management token, a bearer capability: unknown or retired tokens are a plain 404. */
export async function loadTeamManageView({ params }: { params: Promise<{ token: string; }>; }) {
  const { token } = await params;
  const raw = token?.trim() ?? "";
  if (!isTeamTokenShape(raw)) notFound();
  const leader = await resolveTeamByManageToken(raw);
  if (!leader) notFound();
  const data = await loadTeamPageData(leader);
  if (!data) notFound();
  return { data, teamRef: { manageToken: raw } };
}
