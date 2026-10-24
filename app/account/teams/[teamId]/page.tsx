import type { Metadata } from "next";
import { loadAccountTeamView } from "@/lib/views/app__account__teams__teamId__page";
import { TeamPageView } from "@/components/team/TeamPageView";

type Props = {
  params: Promise<{ teamId: string }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your team",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/**
 * A signed-in leader's team page, linked from Account → Registrations. The
 * team id alone grants nothing: it resolves only while this account owns the
 * team's leader registration, and anything else is a plain 404.
 */
export default async function AccountTeamPage({ params }: Props) {
  // The reader authenticates; the account layout is not an authorization boundary.
  const { data, teamRef } = await loadAccountTeamView({ params });
  return <TeamPageView data={data} teamRef={teamRef} tokenPage={false} />;
}
