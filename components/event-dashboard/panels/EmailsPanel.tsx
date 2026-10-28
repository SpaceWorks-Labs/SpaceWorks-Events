import { loadEmailsPanel } from "@/lib/views/components__event-dashboard__panels__EmailsPanel";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { formatRelativeTime } from "@/lib/format/datetime";
import { EventBroadcastPanel } from "@/components/broadcasts/EventBroadcastPanel";
import { NoPermission } from "./shared";
import { AttendanceCheckCard } from "@/components/event-dashboard/emails/AttendanceCheckCard";
import { DEFAULT_BROADCAST_DESIGN, isBroadcastDesign } from "@/lib/email/broadcastDesigns";

export async function EmailsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  const { permissions } = ctx;
  if (!permissions.canSendEmails) return <NoPermission>You do not have permission to email attendees.</NoPermission>;
  const { event, organisation, now, records, brand, statusCounts, delivery, draft, attendanceCheck } = await loadEmailsPanel({ ctx });
  return (
    <div className="flex flex-col gap-8">
    <AttendanceCheckCard organisationSlug={organisation.slug} eventId={event.id} data={attendanceCheck} />
    <EventBroadcastPanel
      organisationSlug={organisation.slug}
      eventId={event.id}
      statusCounts={statusCounts}
      brand={brand}
      draft={draft}
      history={records.map((row) => ({
        id: row.id,
        subject: row.subject,
        body: row.body,
        statuses: row.statuses,
        attendance: row.attendance,
        design: isBroadcastDesign(row.design) ? row.design : DEFAULT_BROADCAST_DESIGN,
        recipientCount: row.recipientCount,
        createdAt: row.createdAt.toISOString(),
        sentLabel: formatRelativeTime(row.createdAt, event.timezone, now),
        createdByName: row.createdBy?.name ?? null,
        delivery: delivery.get(row.id) ?? null,
      }))}
    />
    </div>
  );
}
