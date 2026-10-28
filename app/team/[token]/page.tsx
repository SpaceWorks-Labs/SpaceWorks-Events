import type { Metadata } from "next";
import { loadTeamManageView } from "@/lib/views/app__team__token__page";
import { TeamPageView } from "@/components/team/TeamPageView";
import { SubmissionSection } from "@/components/submission/SubmissionSection";
import { GetHelpCard } from "@/components/mentor-desk/participant/GetHelpCard";
import { MentorsCard } from "@/components/mentor-desk/participant/MentorsCard";

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
  const { data, teamRef, submission, mentorDesk } = await loadTeamManageView({ params });
  // The Mentor Desk (docs/MENTOR_DESK.md) sits with the submission: the same link proves the team.
  const desk = mentorDesk ? (
    <>
      <GetHelpCard deskRef={{ manageToken: teamRef.manageToken }} view={mentorDesk} />
      <MentorsCard deskRef={{ manageToken: teamRef.manageToken }} view={mentorDesk} />
    </>
  ) : null;
  return <TeamPageView data={data} teamRef={teamRef} tokenPage submission={<><SubmissionSection view={submission} submissionRef={{ manageToken: teamRef.manageToken }} />{desk}</>} />;
}
