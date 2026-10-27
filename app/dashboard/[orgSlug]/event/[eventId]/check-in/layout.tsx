import { guardEventCheckIn } from "@/lib/dashboardGuards";

// The check-in desk and badges need OWNER/ADMIN or the CHECK_IN grant (never JUDGE-only).
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function CheckInGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; eventId: string; }>;
}) {
  const { orgSlug, eventId } = await params;
  await guardEventCheckIn(orgSlug, eventId);
  return children;
}
