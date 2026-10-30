"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { cancelSeriesDate, setSeriesDateCapacity } from "@/app/actions/series";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { formatDayTime } from "@/lib/format/datetime";

export type ManagedDate = {
  id: string;
  start: string;
  /** This date's own capacity; null uses the series capacity. */
  capacity: number | null;
  /** Seats taken: confirmed, or held while paying. */
  taken: number;
  cancelled: boolean;
};

/**
 * Upcoming or past cancelled dates: manage capacity, cancel, or finish refunds.
 */
export function SeriesDatesManager({ organisationSlug, seriesId, seriesCapacity, timeZone, dates, canManage }: {
  organisationSlug: string;
  seriesId: string;
  seriesCapacity: number | null;
  timeZone: string;
  dates: ManagedDate[];
  /** Owners and admins change capacity and cancel dates. */
  canManage: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [editing, setEditing] = useState<{ id: string; value: string; } | null>(null);
  const [cancelling, setCancelling] = useState<{ id: string; reason: string; } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function saveCapacity(id: string, value: string) {
    setError(null);
    startTransition(async () => {
      const result = await setSeriesDateCapacity({ organisationSlug, eventSeriesId: seriesId, instanceId: id, capacity: value.trim() ? Number(value) : null });
      if (!result.ok) return setError(result.error);
      setEditing(null);
      showToast("Capacity saved.", "success");
      router.refresh();
    });
  }

  function cancelDate(id: string, reason: string, retry: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await cancelSeriesDate({ organisationSlug, eventSeriesId: seriesId, instanceId: id, reason });
      if (!result.ok) return setError(result.error);
      setCancelling(null);
      const { refunded, failed, notified } = result.data!;
      showToast(`${retry ? "Refund processing finished." : "Date cancelled."} ${refunded} ${refunded === 1 ? "order" : "orders"} refunded, ${notified} ${notified === 1 ? "person" : "people"} emailed.${failed ? ` ${failed} need settling by hand.` : ""}`, failed ? "warning" : "success");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {dates.length === 0 ? <p className="text-body-ui text-ink-muted">No upcoming dates.</p> : null}
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {dates.map((date) => {
          const capacity = date.capacity ?? seriesCapacity;
          return (
            <li key={date.id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className={date.cancelled ? "font-semibold text-ink-muted line-through" : "font-semibold text-ink"}>{formatDayTime(new Date(date.start), timeZone)}</p>
                  <p className="text-caption text-ink-muted">
                    {date.taken} taken{capacity != null ? ` of ${capacity}` : ""}
                    {date.capacity != null ? " (this date's own limit)" : ""}
                  </p>
                </div>
                {date.cancelled ? <Chip tone="neutral" size="sm">Cancelled</Chip> : null}
                <Link href={`/${organisationSlug}/i/${date.id}`} className="inline-flex items-center gap-1 text-sm font-semibold text-ink underline underline-offset-4">
                  View
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </Link>
                {canManage && !date.cancelled ? (
                  <>
                    <Button size="sm" variant="ghost" onClick={() => { setError(null); setCancelling(null); setEditing({ id: date.id, value: date.capacity == null ? "" : String(date.capacity) }); }}>Capacity</Button>
                    <Button size="sm" variant="dangerQuiet" onClick={() => { setError(null); setEditing(null); setCancelling({ id: date.id, reason: "" }); }}>Cancel date</Button>
                  </>
                ) : null}
                {canManage && date.cancelled ? (
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => { setError(null); setEditing(null); setCancelling({ id: date.id, reason: "Finishing cancellation refunds." }); }}>Finish refunds</Button>
                ) : null}
              </div>
              {editing?.id === date.id ? (
                <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); saveCapacity(date.id, editing.value); }}>
                  <Field label="Places on this date" optional helperText={`Blank uses the series capacity${seriesCapacity != null ? ` (${seriesCapacity})` : " (no limit)"}.`}>
                    <Input type="number" min={1} value={editing.value} onChange={(event) => setEditing({ id: date.id, value: event.target.value })} />
                  </Field>
                  <Button type="submit" size="sm" loading={pending} loadingLabel="Saving…">Save</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>Close</Button>
                </form>
              ) : null}
              {cancelling?.id === date.id ? (
                <form className="flex flex-col gap-3 rounded-lg bg-subtle p-3" onSubmit={(event) => { event.preventDefault(); cancelDate(date.id, cancelling.reason, date.cancelled); }}>
                  <p className="text-body-ui text-ink">
                    {date.cancelled ? "Finish any cancellation refunds left for this date, even after it has ended. Orders already processed are skipped; cancellation emails are not sent again." : "Everyone on this date is emailed. Tickets for this date alone are refunded in full; each pass is refunded this date's share and keeps its other dates. This can't be undone."}
                  </p>
                  {!date.cancelled ? <Field label="Reason, for the email" optional>
                    <Input value={cancelling.reason} maxLength={500} onChange={(event) => setCancelling({ id: date.id, reason: event.target.value })} />
                  </Field> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" variant={date.cancelled ? "primary" : "danger"} loading={pending} loadingLabel="Processing…">{date.cancelled ? "Finish refunds" : "Cancel this date and refund"}</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setCancelling(null)}>{date.cancelled ? "Close" : "Keep it"}</Button>
                  </div>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
