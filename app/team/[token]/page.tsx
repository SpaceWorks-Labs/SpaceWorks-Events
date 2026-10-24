import type { Metadata } from "next";
import { loadTeamManageView } from "@/lib/views/app__team__token__page";
import { TeamPageView } from "@/components/team/TeamPageView";

type Props = {
  params: Promise<{ token: string }>;
};

// The management token is a bearer capability: render per request, never
// cache (dynamic pages are sent `private, no-store`), never index, and never
// leak the address through Referer.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your team",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function TeamManagePage({ params }: Props) {
  const { data, teamRef } = await loadTeamManageView({ params });
  return <TeamPageView data={data} teamRef={teamRef} tokenPage />;
}
