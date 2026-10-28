import type { ChipTone } from "@/components/ui/display";
import type { DashboardTeam } from "@/lib/eventDashboard/teams";

export const CHIP_TONES: Record<DashboardTeam["status"], ChipTone> = {
  CONFIRMED: "success",
  WAITLISTED: "warning",
  PENDING_APPROVAL: "warning",
  PENDING_PAYMENT: "warning",
  REJECTED: "danger",
};

export type Member = DashboardTeam["members"][number];
export type Result = { ok: true } | { ok: false; error: string };

export const SEARCH_DELAY_MS = 300;
