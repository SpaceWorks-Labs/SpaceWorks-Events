import { BrandPageLoader } from "@/components/brand/BrandLoader";

// Guarded by the layout above it (lib/views/dashboardGuards.ts).
export default function Loading() {
  return <BrandPageLoader label="Loading schedule" />;
}
