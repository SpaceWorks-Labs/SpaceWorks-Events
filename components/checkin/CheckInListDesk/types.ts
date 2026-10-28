import type { ChipTone } from "@/components/ui/display";

export type ListDeskRosterRow = {
  rsvpId: string;
  displayName: string;
  email: string | null;
  status: string;
  entryCheckedInAt: string | null;
  listCheckedInAt: string | null;
  eligible: boolean;
};

export type RosterFilter = "all" | "collected" | "notCollected";

export type DeskResult =
  | { kind: "success" | "already"; rsvpId: string; displayName: string; email: string | null; message: string; checkedInAt: string }
  | { kind: "refused"; message: string; needsForce: boolean; retry?: { rawInput?: string; rsvpId?: string } };

export const STATUS_CHIPS: Record<string, { label: string; tone: ChipTone }> = {
  WAITLISTED: { label: "Waitlist", tone: "warning" },
  PENDING_APPROVAL: { label: "To approve", tone: "warning" },
  REJECTED: { label: "Declined", tone: "danger" },
};

export const SEARCH_DELAY_MS = 300;
export const NO_COUNTS: Record<RosterFilter, number> = { all: 0, collected: 0, notCollected: 0 };
export type RosterView = { filter: RosterFilter; query: string };
