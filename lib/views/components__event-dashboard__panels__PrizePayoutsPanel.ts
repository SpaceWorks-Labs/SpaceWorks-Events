import type { EventDashboardContext } from "@/lib/eventDashboard/context";
import { loadEventDashboard } from "@/lib/eventDashboard/context";
import { loadPrizeLedger } from "@/lib/prizeLedger";

/** Judging → Prizes: award prizes and the payout ledger. Organisation owners and admins only. */
export async function loadPrizePayoutsPanel({ ctx }: { ctx: EventDashboardContext; }) {
  ctx = await loadEventDashboard(ctx.organisation.slug, ctx.event.id);
  if (!ctx.permissions.isAdmin) return null;
  const ledger = await loadPrizeLedger(ctx.event.id, ctx.organisation.id);
  return ledger ? { ledger, scope: { organisationSlug: ctx.organisation.slug, eventId: ctx.event.id }, timezone: ctx.event.timezone } : null;
}
