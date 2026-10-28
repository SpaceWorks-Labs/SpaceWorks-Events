import { guardTicketDesign } from "@/lib/dashboardGuards";

// A library design for owners and admins, or an event's design for its EDIT_DETAILS editors.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function TicketDesignGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; designId: string; }>;
}) {
  const { orgSlug, designId } = await params;
  await guardTicketDesign(orgSlug, designId);
  return children;
}
