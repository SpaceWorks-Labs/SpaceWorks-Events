import { guardDashboardHome } from "@/lib/dashboardGuards";

// Signed in with the staff authenticator check passed.
// Awaited here, outside this segment's loading.tsx, so a refusal is a real
// 404/307 rather than a streamed 200 (lib/views/dashboardGuards.ts).
export default async function HomeGuardLayout({ children }: { children: React.ReactNode }) {
  await guardDashboardHome();
  return children;
}
