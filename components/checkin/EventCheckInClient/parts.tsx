"use client";

import { useSyncExternalStore } from "react";
import type { CheckInResultData } from "@/app/actions/checkin";
import { BadgeCheck } from "lucide-react";
import { Chip, type ChipTone } from "@/components/ui/display";

function DetailRows({ rows }: { rows: Array<{ key: string; label: string; value: string }> }) {
  if (rows.length === 0) return null;
  return (
    <dl className="m-0 flex flex-col gap-0.5 pt-1">
      {rows.map((detail) => (
        <div key={detail.key} className="flex flex-wrap items-baseline gap-1.5 text-sm">
          <dt className="opacity-75">{detail.label}:</dt>
          <dd className="m-0 font-semibold">{detail.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CheckInDetailsList({ details }: { details: CheckInResultData["checkInDetails"] }) {
  return <DetailRows rows={details.map((detail) => ({ key: detail.label, label: detail.label, value: detail.value }))} />;
}

export function RegistrationDetailsList({ details }: { details: CheckInResultData["registrationDetails"] }) {
  return <DetailRows rows={details.map((detail) => ({ key: detail.key, label: detail.label, value: detail.value }))} />;
}

const statusChips: Record<string, { label: string; tone: ChipTone }> = {
  CONFIRMED: { label: "Confirmed", tone: "success" },
  WAITLISTED: { label: "Waitlisted", tone: "warning" },
  PENDING_APPROVAL: { label: "Pending approval", tone: "warning" },
  REJECTED: { label: "Rejected", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/** A crew ticket (docs/CREW.md). `isCrew` is optional on desk results, so older payloads and rosters show nothing. */
export function CrewChip({ data }: { data: { isCrew?: boolean } }) {
  return data.isCrew === true ? <Chip size="sm" tone="accent" icon={<BadgeCheck />}>Crew</Chip> : null;
}

export function StatusChip({ status }: { status: string }) {
  const chip = statusChips[status] ?? { label: status, tone: "neutral" as ChipTone };
  return <Chip size="sm" tone={chip.tone}>{chip.label}</Chip>;
}

/** Render a stable server/client value first, then adapt to the device locale. */
export function CheckInTimestamp({ value }: { value: string }) {
  const isClient = useSyncExternalStore(() => () => {}, () => true, () => false);
  return <>{isClient ? new Date(value).toLocaleString() : `${value.slice(0, 16).replace("T", " ")} UTC`}</>;
}

