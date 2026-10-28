import { type EventHeaderStat } from "@/components/dashboard/EventManageHeader";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { loadCapacityUsed, loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
import { peopleCount, teamUnitNoun } from "@/lib/teamCapacityDisplay";
import { eventUsesJudging } from "@/lib/eventDashboard/judging";
type Props = {
  params: Promise<{ orgSlug: string; eventId: string; }>;
};

export async function loadEventManageView({ params }: Props) {
  const { orgSlug, eventId } = await params;
  const ctx = await loadEventDashboard(orgSlug, eventId);
  const { organisation, event, permissions } = ctx;
  // A JUDGE-only collaborator sees the judging workspace and nothing else:
  // no tabs, header stats, page link, or check-in (docs/HACKATHON.md).
  if (permissions.isJudgeOnly) return { judgeOnly: true as const, organisation, event, permissions, ctx };
  // A REVIEW_APPLICATIONS-only collaborator sees their review workspace (and judging, if they judge) alone (docs/ADMISSION.md).
  if (permissions.isReviewerOnly) return { judgeOnly: true as const, organisation, event, permissions, ctx };
  const teamMode = event.registrationMode === "TEAM";
  const [counts, capacityUsed] = permissions.canManageRegistrations
    ? await Promise.all([loadRsvpStatusCounts(event.id), loadCapacityUsed(event.id, event.registrationMode)])
    : [null, null];
  // Crew (docs/CREW.md) are going but take no place, so they are named beside the places.
  const crewNote = counts?.crew ? `${counts.crew} crew` : null;
  // TEAM events: capacity counts units (teams plus solo registrants), people are shown beside it.
  const placesStat: EventHeaderStat | null =
    counts && teamMode && capacityUsed != null
      ? {
          label: "Places taken",
          value: event.capacity ? `${capacityUsed} / ${event.capacity}` : capacityUsed,
          detail: [teamUnitNoun(event.soloPolicy, event.capacity ?? capacityUsed), `${peopleCount(counts.confirmed)} going`, crewNote].filter(Boolean).join(" · "),
          meter: event.capacity ? { filled: capacityUsed, total: event.capacity, tone: "accent" } : undefined,
        }
      : null;
  const stats: EventHeaderStat[] | undefined = counts
    ? [
      placesStat ?? {
        label: "Going",
        value: event.capacity && capacityUsed != null ? `${capacityUsed} / ${event.capacity}` : counts.confirmed,
        detail: crewNote ? (event.capacity ? `+ ${crewNote} · ${counts.confirmed} going` : `incl. ${crewNote}`) : undefined,
        meter: event.capacity && capacityUsed != null ? { filled: capacityUsed, total: event.capacity, tone: "accent" } : undefined,
      },
      { label: "Waitlist", value: counts.waitlisted },
      { label: "To approve", value: counts.pendingApproval },
      { label: "Checked in", value: counts.checkedIn, meter: counts.confirmed ? { filled: counts.checkedIn, total: counts.confirmed, tone: "success" } : undefined },
    ]
    : undefined;
  // Judging tab: only on events that use judging, so ordinary events keep
  // eight tabs. Until then owners and admins turn submissions on in Settings.
  const showJudging = (permissions.canManageJudging || permissions.canJudge) && (await eventUsesJudging(ctx));
  // Applications tab (docs/ADMISSION.md): only on events taking applications; turned on in Settings.
  const showApplications = event.admissionEnabled && (permissions.canManageApplications || permissions.canReviewApplications);
  const publicPath = `/${organisation.slug}/${event.slug}`;
  return { judgeOnly: false as const, organisation, event, stats, permissions, ctx, publicPath, counts, showJudging, showApplications };
}
