import { guardOrgOwner } from "@/lib/dashboardGuards";

// The organisation's own email server is for owners.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function EmailSettingsGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; }>;
}) {
  const { orgSlug } = await params;
  await guardOrgOwner(orgSlug);
  return children;
}
