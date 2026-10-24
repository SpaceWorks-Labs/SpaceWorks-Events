import type { RsvpStatus } from "@prisma/client";
import type { ManualRsvpField } from "@/components/attendees/ManualRsvpDialog";

/** One registration as the dashboard guest list and its dialogs receive it. */
export type AttendeeRow = {
  id: string;
  status: RsvpStatus;
  createdAt: string;
  guestEmail: string | null;
  guestName?: string | null;
  user: { id: string; name: string | null; email: string | null } | null;
  checkedInAt: string | null;
  /** Custom check-in lists ("Swag", "Lunch") this guest has been checked into. */
  listCheckIns?: { listName: string; checkedInAt: string }[];
  ticketUrl: string;
  /** Paid events: the ticket bought and the order it belongs to. */
  ticketName?: string | null;
  order?: AttendeeOrder | null;
  /** TEAM events: the registration's team (null when solo; absent elsewhere). */
  team?: { id: string; name: string; isLeader: boolean } | null;
  answers?: { label: string; value: string }[];
  rawAnswers?: Array<{
    fieldId: string;
    valueText?: string | null;
    valueBool?: boolean | null;
    valueNumber?: number | null;
    valueDate?: string | null;
  }>;
  registrationFields?: ManualRsvpField[];
};

/** A paid order as the guest list shows it; operations act on the whole order. */
export type AttendeeOrder = {
  id: string;
  reference: string;
  status: "REQUESTED" | "PENDING" | "CONFIRMED" | "EXPIRED" | "CANCELLED";
  totalMinor: number;
  currency: string;
  testMode: boolean;
  tickets: number;
  /** How a confirmed order was settled; "desk" is reserved, to be paid in person. */
  settlement: "online" | "offline" | "waived" | "desk" | null;
  paidMinor: number;
  refundedMinor: number;
  refundPendingMinor: number;
  /** The offline payment's record, as amended. */
  offlinePayment: { id: string; method: string | null; reference: string | null; } | null;
  /** The latest chargeback on a payment, if any. */
  dispute?: { status: "OPEN" | "UNDER_REVIEW" | "WON" | "LOST" | "CLOSED"; respondBy: string | null; } | null;
};
