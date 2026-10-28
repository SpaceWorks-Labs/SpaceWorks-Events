"use client";

import { useId } from "react";
import { Minus, Plus } from "lucide-react";
import { IconButton } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { formatMoney, minorToDecimalString, parseMoneyToMinor } from "@/lib/payments/money";
import type { PublicAddOn, PublicTicketType } from "@/lib/payments/tickets";

/** Whether a ticket can be chosen right now. */
export function ticketAvailable(ticket: PublicTicketType, paidSalesOpen: boolean) {
  return ticket.sales === "on_sale" && ticket.remaining !== 0 && (ticket.priceMinor === 0 || paidSalesOpen);
}

/** The most of one ticket this order may take. */
export function ticketLimit(ticket: PublicTicketType) {
  return Math.max(0, Math.min(ticket.maxPerOrder, ticket.remaining ?? ticket.maxPerOrder));
}

/** What a series pass covers; the count is unknown (null) when the dates are not loaded. */
export function passLabel(passDates: number | null) {
  if (passDates == null) return "Pass for all remaining dates";
  return passDates === 1 ? "Pass for the 1 remaining date" : `Pass for all ${passDates} remaining dates`;
}

function availabilityNote(ticket: PublicTicketType, paidSalesOpen: boolean) {
  if (ticket.sales === "not_started") return "Not on sale yet";
  if (ticket.sales === "ended") return "Sales ended";
  if (ticket.remaining === 0) return "Sold out";
  if (ticket.priceMinor > 0 && !paidSalesOpen) return "Not on sale right now";
  if (ticket.remaining != null && ticket.remaining <= 10) return `${ticket.remaining} left`;
  return null;
}

/**
 * How many of each ticket to buy. Quantities stay within each ticket's
 * per-order limits and what is left; the server checks both again under its lock.
 */
export function TicketPicker({ tickets, quantities, onChange, error, paidSalesOpen, amounts = {}, onAmountChange }: {
  tickets: PublicTicketType[];
  quantities: Record<string, number>;
  onChange: (quantities: Record<string, number>) => void;
  error?: string;
  paidSalesOpen: boolean;
  /** Pay what you want: the price chosen per ticket, in minor units. */
  amounts?: Record<string, number>;
  onAmountChange?: (ticketTypeId: string, amountMinor: number | null) => void;
}) {
  const legendId = useId();
  const errorId = useId();
  const set = (ticket: PublicTicketType, quantity: number) => {
    const next = quantity <= 0 ? 0 : Math.max(ticket.minPerOrder, Math.min(quantity, ticketLimit(ticket)));
    // One order is a pass or tickets for this date, never both.
    const kept = next > 0 ? Object.fromEntries(Object.entries(quantities).filter(([id]) => tickets.find((other) => other.id === id)?.pass === ticket.pass)) : quantities;
    onChange({ ...kept, [ticket.id]: next });
  };
  return (
    <fieldset className="flex flex-col gap-2.5" aria-describedby={error ? errorId : undefined}>
      <legend id={legendId} className="mb-1.5 text-sm font-semibold text-ink">Tickets</legend>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {tickets.map((ticket) => {
          const available = ticketAvailable(ticket, paidSalesOpen);
          const quantity = quantities[ticket.id] ?? 0;
          const note = availabilityNote(ticket, paidSalesOpen);
          const price = ticket.flexible
            ? ticket.priceMinor > 0 ? `From ${formatMoney(ticket.priceMinor, ticket.currency)}` : "Pay what you want"
            : ticket.priceMinor > 0 ? formatMoney(ticket.priceMinor, ticket.currency) : "Free";
          const details = [
            ticket.seatsPerTicket > 1 ? `Admits ${ticket.seatsPerTicket}` : null,
            ticket.feeMinor > 0 ? `+ ${formatMoney(ticket.feeMinor, ticket.currency)} booking fee` : null,
            ticket.visibility === "MEMBERS" ? "Members only" : ticket.visibility === "CODE" ? "Unlocked with your code" : null,
          ].filter(Boolean);
          const amount = amounts[ticket.id];
          return (
            <li key={ticket.id} className="flex flex-col gap-2 p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-body-ui text-ink">
                    <span className="font-semibold">{ticket.name}</span>
                    <span>{price}</span>
                  </p>
                  {ticket.pass ? <p className="text-caption font-semibold text-ink-secondary">{passLabel(ticket.passDates)}</p> : null}
                  {details.length ? <p className="text-caption font-semibold text-ink-secondary">{details.join(" · ")}</p> : null}
                  {ticket.description || note ? <p className="text-caption text-ink-muted">{[ticket.description, note].filter(Boolean).join(" · ")}</p> : null}
                </div>
                <div className="flex items-center gap-2" role="group" aria-label={`${ticket.name} quantity`}>
                  <IconButton size="sm" variant="secondary" label={`One fewer ${ticket.name}`} disabled={!available || quantity === 0} onClick={() => set(ticket, quantity - 1 < ticket.minPerOrder ? 0 : quantity - 1)}>
                    <Minus />
                  </IconButton>
                  <output aria-live="polite" className="w-6 text-center tabular-nums font-semibold text-ink">{quantity}</output>
                  <IconButton size="sm" variant="secondary" label={`One more ${ticket.name}`} disabled={!available || quantity >= ticketLimit(ticket)} onClick={() => set(ticket, quantity === 0 ? ticket.minPerOrder : quantity + 1)}>
                    <Plus />
                  </IconButton>
                </div>
              </div>
              {ticket.flexible && quantity > 0 ? (
                <Field
                  label={`Your price per ticket (${ticket.currency})`}
                  helperText={[
                    ticket.priceMinor > 0 ? `At least ${formatMoney(ticket.priceMinor, ticket.currency)}` : "Any amount, including nothing",
                    ticket.suggestedMinor != null ? `suggested ${formatMoney(ticket.suggestedMinor, ticket.currency)}` : null,
                    ticket.maxPriceMinor != null ? `up to ${formatMoney(ticket.maxPriceMinor, ticket.currency)}` : null,
                  ].filter(Boolean).join(", ")}
                >
                  <Input
                    inputMode="decimal"
                    placeholder={minorToDecimalString(ticket.suggestedMinor ?? ticket.priceMinor, ticket.currency)}
                    defaultValue={amount != null ? minorToDecimalString(amount, ticket.currency) : ""}
                    onChange={(event) => {
                      // Unreadable text prices as NaN, which the shared rules turn into a message.
                      const parsed = event.target.value.trim() ? parseMoneyToMinor(event.target.value, ticket.currency) : null;
                      onAmountChange?.(ticket.id, event.target.value.trim() ? (parsed == null ? Number.NaN : Number(parsed)) : null);
                    }}
                  />
                </Field>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p id={errorId} role="alert" className="text-caption text-danger-fg">{error}</p> : null}
    </fieldset>
  );
}

/** Extras bought alongside tickets: a quantity for each. */
export function AddOnPicker({ addOns, quantities, onChange }: {
  addOns: PublicAddOn[];
  quantities: Record<string, number>;
  onChange: (quantities: Record<string, number>) => void;
}) {
  if (addOns.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2.5">
      <legend className="mb-1.5 text-sm font-semibold text-ink">Extras</legend>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {addOns.map((addOn) => {
          const quantity = quantities[addOn.id] ?? 0;
          const limit = Math.min(addOn.maxPerOrder, addOn.remaining ?? addOn.maxPerOrder);
          return (
            <li key={addOn.id} className="flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-body-ui text-ink">
                  <span className="font-semibold">{addOn.name}</span>
                  <span>{addOn.priceMinor > 0 ? formatMoney(addOn.priceMinor, addOn.currency) : "Free"}</span>
                </p>
                {addOn.description || addOn.remaining === 0 ? <p className="text-caption text-ink-muted">{[addOn.description, addOn.remaining === 0 ? "Sold out" : null].filter(Boolean).join(" · ")}</p> : null}
              </div>
              <div className="flex items-center gap-2" role="group" aria-label={`${addOn.name} quantity`}>
                <IconButton size="sm" variant="secondary" label={`One fewer ${addOn.name}`} disabled={quantity === 0} onClick={() => onChange({ ...quantities, [addOn.id]: quantity - 1 })}>
                  <Minus />
                </IconButton>
                <output aria-live="polite" className="w-6 text-center tabular-nums font-semibold text-ink">{quantity}</output>
                <IconButton size="sm" variant="secondary" label={`One more ${addOn.name}`} disabled={quantity >= limit} onClick={() => onChange({ ...quantities, [addOn.id]: quantity + 1 })}>
                  <Plus />
                </IconButton>
              </div>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
