import { loadEventManageView } from "@/lib/views/app__dashboard__orgSlug__event__eventId__page";
import Link from "next/link";
import { ArrowUpRight, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EventManageHeader } from "@/components/dashboard/EventManageHeader";
import { EventReportDownloadButton } from "@/components/reports/EventReportDownloadButton";
import { CopyEventLink } from "@/components/dashboard/home/CopyEventLink";
import { EventDashboardTabs } from "@/components/event-dashboard/EventDashboardTabs";
import { OverviewPanel } from "@/components/event-dashboard/panels/OverviewPanel";
import { GuestsPanel } from "@/components/event-dashboard/panels/GuestsPanel";
import { EventPagePanel } from "@/components/event-dashboard/panels/EventPagePanel";
import { EmailsPanel } from "@/components/event-dashboard/panels/EmailsPanel";
import { CheckInPanel } from "@/components/event-dashboard/panels/CheckInPanel";
import { FeedbackPanel } from "@/components/event-dashboard/panels/FeedbackPanel";
import { AnalyticsPanel } from "@/components/event-dashboard/panels/AnalyticsPanel";
import { SettingsPanel } from "@/components/event-dashboard/panels/SettingsPanel";
import { JudgingPanel } from "@/components/event-dashboard/panels/JudgingPanel";
import { FinancePanel } from "@/components/event-dashboard/panels/FinancePanel";
import { JudgeWorkspace } from "@/components/event-dashboard/judging/JudgeWorkspace";
import { ApplicationsPanel } from "@/components/event-dashboard/panels/ApplicationsPanel";
import { ReviewWorkspace } from "@/components/event-dashboard/admission/ReviewWorkspace";
import { MentorsPanel } from "@/components/event-dashboard/panels/MentorsPanel";
import { MentorConsole } from "@/components/event-dashboard/mentors/MentorConsole";

type Props = {
  params: Promise<{ orgSlug: string; eventId: string; }>;
};

export const metadata = { title: "Manage event", robots: { index: false, follow: false } };

export default async function EventManagePage({ params }: Props) {
  const view = await loadEventManageView({ params });
  if (view.judgeOnly || view.mentorOnly) {
    const { organisation, event, ctx } = view;
    return (
      <div className="flex flex-col gap-6">
        <EventManageHeader
          back={{ href: `/dashboard/${organisation.slug}`, label: "All events" }}
          event={{ title: event.title, status: event.status, privacyType: event.privacyType, startDateTime: event.startDateTime, endDateTime: event.endDateTime, timezone: event.timezone, accentColor: event.page?.accentColor }}
        />
        {ctx.permissions.canMentor ? <MentorConsole ctx={ctx} /> : null}
        {ctx.permissions.canJudge ? <JudgeWorkspace ctx={ctx} /> : null}
        {ctx.permissions.canReviewApplications && event.admissionEnabled ? <ReviewWorkspace ctx={ctx} /> : null}
      </div>
    );
  }
  const { organisation, event, stats, permissions, ctx, publicPath, counts, showJudging, showMentors, showApplications } = view;
  return (
    <div className="flex flex-col gap-6">
      <EventManageHeader
        back={{ href: `/dashboard/${organisation.slug}`, label: "All events" }}
        event={{
          title: event.title,
          status: event.status,
          privacyType: event.privacyType,
          startDateTime: event.startDateTime,
          endDateTime: event.endDateTime,
          timezone: event.timezone,
          location: event.location,
          isOnline: event.isOnline,
          accentColor: event.page?.accentColor,
        }}
        stats={stats}
        actions={
          <>
            {permissions.canDownloadReports && event.endDateTime < ctx.now ? <EventReportDownloadButton href={`/api/reports/event/${event.id}`} /> : null}
            <Button asChild variant="secondary">
              <Link href={publicPath}>
                View page
                <ArrowUpRight aria-hidden className="size-4" />
              </Link>
            </Button>
            {event.status === "PUBLISHED" ? <CopyEventLink path={publicPath} title={event.title} compact /> : null}
            {permissions.canCheckIn ? (
              <Button asChild variant="accent">
                <Link href={`/dashboard/${organisation.slug}/event/${event.id}/check-in`}>
                  <QrCode aria-hidden className="size-[18px]" />
                  Open check-in
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <EventDashboardTabs
        badges={{ guests: counts?.pendingApproval ?? 0 }}
        hidden={[...(showJudging ? [] : ["judging" as const]), ...(showMentors ? [] : ["mentors" as const]), ...(showApplications ? [] : ["applications" as const])]}
        panels={{
          overview: <OverviewPanel ctx={ctx} />,
          guests: <GuestsPanel ctx={ctx} />,
          page: <EventPagePanel ctx={ctx} />,
          emails: <EmailsPanel ctx={ctx} />,
          "check-in": <CheckInPanel ctx={ctx} />,
          judging: showJudging ? <JudgingPanel ctx={ctx} /> : null,
          applications: showApplications ? <ApplicationsPanel ctx={ctx} /> : null,
          mentors: showMentors ? <MentorsPanel ctx={ctx} /> : null,
          feedback: <FeedbackPanel ctx={ctx} />,
          analytics: <AnalyticsPanel ctx={ctx} />,
          finance: <FinancePanel ctx={ctx} />,
          settings: <SettingsPanel ctx={ctx} judgingInUse={showJudging} />,
        }}
      />
    </div>
  );
}
