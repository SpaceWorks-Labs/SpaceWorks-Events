import { guardOrgAdmin } from "@/lib/dashboardGuards";

// The ticket design library is for owners and admins.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function TicketDesignsGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; }>;
}) {
  const { orgSlug } = await params;
  await guardOrgAdmin(orgSlug);
  return children;
}
