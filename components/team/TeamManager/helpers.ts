import type { ChipTone } from "@/components/ui/display";
import type { TeamManagerProps } from "./types";

export function teamStatus(status: TeamManagerProps["team"]["status"]): { label: string; tone: ChipTone } {
  switch (status) {
    case "CONFIRMED":
      return { label: "Confirmed", tone: "success" };
    case "WAITLISTED":
      return { label: "Waitlisted", tone: "warning" };
    case "PENDING_APPROVAL":
      return { label: "Waiting for approval", tone: "warning" };
    case "PENDING_PAYMENT":
      return { label: "Waiting for payment", tone: "warning" };
    case "REJECTED":
      return { label: "Declined", tone: "danger" };
  }
}

/** Copy-time only: without a configured base URL, fall back to this browser's origin. */
export function absolute(baseUrl: string, path: string) {
  return `${baseUrl || window.location.origin}${path}`;
}
