import { guardWebhookEndpoint } from "@/lib/dashboardGuards";

// One of the organisation's own webhook endpoints, for owners and admins.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function WebhookEndpointGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; endpointId: string; }>;
}) {
  const { orgSlug, endpointId } = await params;
  await guardWebhookEndpoint(orgSlug, endpointId);
  return children;
}
