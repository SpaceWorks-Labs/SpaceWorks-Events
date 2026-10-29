"use client";

import { RotateCcw } from "lucide-react";
import { retryFailedRefundAction } from "@/app/actions/payment-operations";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { useSave } from "@/components/event-dashboard/finance/shared";
import { formatDayTime } from "@/lib/format/datetime";
import type { FailedRefundRow } from "@/lib/payments/operations/retryRefund";

/**
 * Refunds the payment provider refused, by order, for owners and admins
 * (docs/PAYMENTS.md). Listed by order rather than by guest, so a cancelled
 * order whose tickets are gone can still be refunded. Retrying sends a new
 * refund for the same amount; it needs a recent sign-in.
 */
export function FailedRefundsList({ target, refunds, timezone }: { target: { organisationSlug: string; eventId?: string; seriesId?: string; }; refunds: FailedRefundRow[]; timezone: string; }) {
  const { pending, error, save } = useSave();
  if (refunds.length === 0) return <p className="text-caption text-ink-muted">No failed refunds.</p>;
  return (
    <div className="flex flex-col gap-3">
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      <ul className="flex flex-col divide-y divide-line">
        {refunds.map((refund) => (
          <li key={refund.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-body-ui font-semibold text-ink">{refund.buyer} · order {refund.reference} · {refund.amount}</p>
              <p className="text-caption text-ink-muted">{refund.failedAt ? `Refused ${formatDayTime(refund.failedAt, timezone)}` : "Refused"}{refund.orderCancelled ? " · tickets cancelled" : ""}</p>
              {refund.reason ? <p className="mt-1 text-caption text-ink-muted">{refund.reason}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <Chip tone="danger" size="sm">Failed</Chip>
              <Button
                size="sm"
                variant="secondary"
                startIcon={<RotateCcw aria-hidden />}
                loading={pending}
                loadingLabel="Retrying…"
                onClick={() => save(() => retryFailedRefundAction({ ...target, refundId: refund.id }), "Refund sent again.")}
              >
                Retry refund
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
