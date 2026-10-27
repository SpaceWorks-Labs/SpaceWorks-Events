import { BrandPageLoader } from "@/components/brand/BrandLoader";
import { OrgDashboardSkeleton } from "@/components/dashboard/OrgDashboardSkeleton";

export default function Loading() {
  return (
    <div className="flex flex-col gap-6">
      <BrandPageLoader label="Loading organisation" />
      <OrgDashboardSkeleton />
    </div>
  );
}
