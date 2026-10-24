import { type EventHeaderStat } from "@/components/dashboard/EventManageHeader";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
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
  const counts = permissions.canManageRegistrations ? await loadRsvpStatusCounts(event.id) : null;
  const stats: EventHeaderStat[] | undefined = counts
    ? [
      { label: "Going", value: event.capacity ? `${counts.confirmed} / ${event.capacity}` : counts.confirmed, meter: event.capacity ? { filled: counts.confirmed, total: event.capacity, tone: "accent" } : undefined },
      { label: "Waitlist", value: counts.waitlisted },
      { label: "To approve", value: counts.pendingApproval },
      { label: "Checked in", value: counts.checkedIn, meter: counts.confirmed ? { filled: counts.checkedIn, total: counts.confirmed, tone: "success" } : undefined },
    ]
    : undefined;
  // Judging tab: only on events that use judging, so ordinary events keep
  // eight tabs. Until then owners and admins turn submissions on in Settings.
  const showJudging = (permissions.canManageJudging || permissions.canJudge) && (await eventUsesJudging(ctx));
  const publicPath = `/${organisation.slug}/${event.slug}`;
  return { judgeOnly: false as const, organisation, event, stats, permissions, ctx, publicPath, counts, showJudging };
}
