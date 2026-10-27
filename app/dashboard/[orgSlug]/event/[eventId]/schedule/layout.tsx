import { guardEventSchedule } from "@/lib/dashboardGuards";

// The schedule needs the PUBLISH_AND_SCHEDULE grant.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function ScheduleGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; eventId: string; }>;
}) {
  const { orgSlug, eventId } = await params;
  await guardEventSchedule(orgSlug, eventId);
  return children;
}
