import { Prisma, type RsvpStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadRsvpStatusCounts } from "@/lib/eventDashboard/data";
import { loadEventBroadcastDraftForUser } from "@/app/actions/broadcasts/drafts";
import { loadAttendanceCheckCard } from "@/lib/eventDashboard/attendanceCheckCard";
export async function loadEmailsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);

  const { event, permissions, organisation, now, userId } = ctx;
  if (!permissions.canSendEmails) notFound();
  const [records, counts, branding, savedDraft, attendanceCheck] = await Promise.all([
    prisma.eventBroadcast.findMany({
      where: { eventId: event.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, subject: true, body: true, design: true, statuses: true, attendance: true, recipientCount: true, createdAt: true, createdBy: { select: { name: true } } },
    }),
    loadRsvpStatusCounts(event.id),
    prisma.event.findUnique({ where: { id: event.id }, select: { coverImageUrl: true, page: { select: { accentColor: true } } } }),
    // Only the signed-in organiser's own draft, through the composer's own access check.
    loadEventBroadcastDraftForUser(userId, { organisationSlug: organisation.slug, eventId: event.id }),
    // Attendance confirmation card: same audience rule as broadcasts (`canSendEmails`, checked above). Counts only.
    loadAttendanceCheckCard(event, now),
  ]);
  const draft = savedDraft.ok ? (savedDraft.data?.draft ?? null) : null;
  const brand = { accentColor: branding?.page?.accentColor ?? null, coverImageUrl: branding?.coverImageUrl ?? null };
  const statusCounts: Record<RsvpStatus, number> = {
    CONFIRMED: counts.confirmed,
    WAITLISTED: counts.waitlisted,
    PENDING_APPROVAL: counts.pendingApproval,
    REJECTED: counts.rejected,
    PENDING_PAYMENT: counts.pendingPayment,
  };

  // Delivery per broadcast, from the outbox: status counts only, never recipients.
  const ids = records.map((row) => row.id);
  const groups = ids.length
    ? await prisma.$queryRaw<Array<{ broadcastId: string; status: string; count: bigint }>>`
      SELECT "payload"->>'broadcastId' AS "broadcastId", "status"::text AS "status", COUNT(*) AS "count"
      FROM "OutboxMessage"
      WHERE "kind" = 'event-broadcast' AND "payload"->>'broadcastId' IN (${Prisma.join(ids)})
      GROUP BY 1, 2`
    : [];
  const retentionMs = Math.max(Number(process.env.OUTBOX_RETENTION_DAYS || 30), 1) * 86_400_000;
  const delivery = new Map(records.map((row) => {
    const own = groups.filter((group) => group.broadcastId === row.id);
    const count = (...statuses: string[]) => own.filter((group) => statuses.includes(group.status)).reduce((sum, group) => sum + Number(group.count), 0);
    const sent = count("SENT");
    const waiting = count("PENDING", "PROCESSING");
    const failed = count("FAILED");
    // Sent and failed rows are purged after the outbox retention period.
    const expired = now.getTime() - row.createdAt.getTime() > retentionMs;
    return [row.id, { sent, waiting, failed, skipped: expired ? 0 : Math.max(0, row.recipientCount - sent - waiting - failed), expired }];
  }));

  return { event, permissions, organisation, now, records, brand, statusCounts, delivery, draft, attendanceCheck };
}

import { notFound } from "next/navigation";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
