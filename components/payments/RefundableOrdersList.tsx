"use client";

import { useState } from "react";
import { Undo2 } from "lucide-react";
import { refundEndedOrderAction } from "@/app/actions/payment-operations";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { Field, Input, Textarea } from "@/components/ui/field";
import { useSave } from "@/components/event-dashboard/finance/shared";
import { formatDayTime } from "@/lib/format/datetime";
import type { RefundableOrderRow } from "@/lib/payments/operations/cancelledRefund";

/**
 * Cancelled or expired orders with money still refundable, for owners and
 * admins (docs/PAYMENTS.md "Refundable orders"): a cancellation refunded in
 * part, or a late payment's order. Refunded by order, so it works after the
 * tickets are gone. Needs a recent sign-in.
 */
export function RefundableOrdersList({ target, orders, timezone }: { target: { organisationSlug: string; eventId?: string; seriesId?: string; }; orders: RefundableOrderRow[]; timezone: string; }) {
  const [refunding, setRefunding] = useState<RefundableOrderRow | null>(null);
  if (orders.length === 0) return <p className="text-caption text-ink-muted">No cancelled or expired orders have money left to refund.</p>;
  return (
    <>
      <ul className="flex flex-col divide-y divide-line">
        {orders.map((order) => (
          <li key={order.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="text-body-ui font-semibold text-ink">{order.buyer} · order {order.reference}</p>
              <p className="text-caption text-ink-muted">Ordered {formatDayTime(order.orderedAt, timezone)} · {order.left} left to refund</p>
            </div>
            <div className="flex items-center gap-2">
              <Chip tone="neutral" size="sm">{order.status === "cancelled" ? "Cancelled" : "Expired"}</Chip>
              <Button size="sm" variant="secondary" startIcon={<Undo2 aria-hidden />} onClick={() => setRefunding(order)}>Refund…</Button>
            </div>
          </li>
        ))}
      </ul>
      {refunding ? <RefundDialog target={target} order={refunding} onClose={() => setRefunding(null)} /> : null}
    </>
  );
}

function RefundDialog({ target, order, onClose }: { target: { organisationSlug: string; eventId?: string; seriesId?: string; }; order: RefundableOrderRow; onClose: () => void; }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const { pending, error, save } = useSave();
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent size="md">
        <DialogHeader title="Refund this order" description={`${order.buyer} · order ${order.reference} · ${order.left} left`} />
        <DialogBody className="pb-6">
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            save(() => refundEndedOrderAction({ ...target, orderId: order.id, amount, reason }), "Refund sent.", onClose);
          }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label={`Amount (${order.currency})`} optional helperText="Leave blank to refund everything left."><Input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} maxLength={20} /></Field>
            <Field label="Reason"><Textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} required /></Field>
            <div><Button type="submit" variant="primary" loading={pending} loadingLabel="Refunding…">Refund</Button></div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
