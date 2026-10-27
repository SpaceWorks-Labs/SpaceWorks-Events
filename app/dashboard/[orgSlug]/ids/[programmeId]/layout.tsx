import { guardIdProgramme } from "@/lib/dashboardGuards";

// One of the organisation's own member ID programmes.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function IdProgrammeGuardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; programmeId: string; }>;
}) {
  const { orgSlug, programmeId } = await params;
  await guardIdProgramme(orgSlug, programmeId);
  return children;
}
