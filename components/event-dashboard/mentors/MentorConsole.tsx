import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadMentorConsoleView } from "@/lib/views/components__event-dashboard__mentors__MentorConsole";
import { Callout, Chip, EmptyState } from "@/components/ui/display";
import { MentorQueue } from "@/components/mentor-desk/mentor/MentorQueue";
import { RoundVisits } from "@/components/mentor-desk/mentor/RoundVisits";
import { DeclareConflict } from "@/components/mentor-desk/mentor/DeclareConflict";
import { ProfileForm } from "@/components/mentor-desk/ProfileForm";
import { SlotEditor } from "@/components/mentor-desk/SlotEditor";
import { SubTabs } from "../SubTabs";

/**
 * The mentor console (docs/MENTOR_DESK.md): what a MENTOR grant holder sees,
 * on its own for a mentor-only collaborator or as "My console" for an
 * organiser who also mentors. My queue, my teams, my office hours, the live
 * round's visits and my profile. No guests, answers, emails or settings.
 */
export async function MentorConsole({ ctx }: { ctx: EventDashboardContext }) {
  const data = await loadMentorConsoleView({ ctx });
  if (!data) {
    return <Callout tone="info">The Mentor Desk is not open for this event yet, or your mentor profile is not ready. Ask the organisers.</Callout>;
  }
  const { view, scope } = data;
  const bounds = { start: view.profile.eventStart, end: view.profile.eventEnd };
  return (
    <SubTabs
      label="Mentor console"
      items={[
        { value: "console-queue", label: "My queue", count: view.queue.filter((r) => r.eligible).length, content: <MentorQueue scope={scope} view={view} /> },
        {
          value: "console-teams",
          label: "My teams",
          count: view.myTeams.length,
          content: (
            <div className="flex flex-col gap-4">
              {view.myTeams.length === 0 ? <EmptyState title="No teams yet">Organisers assign teams to you; you get an email when they do.</EmptyState> : (
                <ul className="flex flex-wrap gap-2">{view.myTeams.map((t) => <li key={`${t.teamId}-${t.roundId ?? ""}`}><Chip tone="accent">{t.teamName}{t.roundId && view.round?.id === t.roundId ? ` · ${view.round.label}` : ""}</Chip></li>)}</ul>
              )}
              <DeclareConflict scope={scope} teams={view.teams} conflicts={view.conflicts} />
            </div>
          ),
        },
        { value: "console-slots", label: "My office hours", count: view.slots.length, content: <SlotEditor scope={scope} as="mentor" timeZone={view.timezone} bounds={bounds} slots={view.slots.map((s) => ({ ...s, bookings: s.teams.map((teamName) => ({ teamName })) }))} /> },
        { value: "console-round", label: "Round visits", content: view.round ? <RoundVisits scope={scope} round={view.round} /> : <EmptyState title="No round is live">Organisers open mentoring rounds for team check-ins.</EmptyState> },
        { value: "console-profile", label: "Profile", content: <ProfileForm scope={scope} mentorUserId={ctx.userId} profile={view.profile} timeZone={view.timezone} bounds={bounds} as="mentor" /> },
      ]}
    />
  );
}
