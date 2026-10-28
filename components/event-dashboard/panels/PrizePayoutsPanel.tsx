import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadPrizePayoutsPanel } from "@/lib/views/components__event-dashboard__panels__PrizePayoutsPanel";
import { PrizePayouts } from "@/components/event-dashboard/judging/PrizePayouts";
import { NoPermission } from "./shared";

/** Judging → Prizes: award prize money and its payout ledger, for organisation owners and admins. */
export async function PrizePayoutsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  const data = await loadPrizePayoutsPanel({ ctx });
  if (!data) return <NoPermission>Only organisation owners and admins can manage prize money.</NoPermission>;
  return <PrizePayouts scope={data.scope} ledger={data.ledger} timezone={data.timezone} />;
}
