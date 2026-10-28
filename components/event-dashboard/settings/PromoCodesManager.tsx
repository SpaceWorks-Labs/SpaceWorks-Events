"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { archivePromoCode, createPromoCode, saveRefundPolicy, saveTransferPolicy } from "@/app/actions/ticket-types";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { useToast } from "@/components/feedback/ToastProvider";
import { Button } from "@/components/ui/button";
import { CheckboxField, Radio, RadioGroup } from "@/components/ui/choice";
import { Callout, Card, CardHeader } from "@/components/ui/display";
import { Dropdown, Field, Input, Textarea } from "@/components/ui/field";
import type { TicketTarget } from "@/components/event-dashboard/settings/TicketTypesManager";
import { formatMoney } from "@/lib/payments/money";
import { describeRefundPolicy, type RefundPolicySnapshot } from "@/lib/payments/refundPolicy";
import { HelpLink } from "@/components/help/HelpLink";

export type ManagedPromoCode = {
  id: string;
  hint: string;
  kind: "PERCENT" | "FIXED";
  appliesPer: "TICKET" | "ORDER";
  percentOff: number | null;
  amountOffMinor: number | null;
  ticketTypeId: string | null;
  minQuantity: number;
  perOrderLimit: number | null;
  maxRedemptions: number | null;
  validFrom: string | null;
  validUntil: string | null;
  uses: number;
};

type Draft = {
  code: string; kind: "PERCENT" | "FIXED"; appliesPer: "TICKET" | "ORDER"; value: string; ticketTypeId: string;
  minQuantity: string; perOrderLimit: string; maxRedemptions: string; validFrom: string; validUntil: string;
};

const EMPTY: Draft = { code: "", kind: "PERCENT", appliesPer: "TICKET", value: "", ticketTypeId: "", minQuantity: "1", perOrderLimit: "", maxRedemptions: "", validFrom: "", validUntil: "" };

function optionalNumber(value: string) {
  return value.trim() ? Number(value) : null;
}

function optionalIso(value: string) {
  return value ? new Date(value).toISOString() : null;
}

function describeDiscount(promo: ManagedPromoCode, currency: string) {
  const amount = promo.kind === "PERCENT" ? `${promo.percentOff}% off` : `${formatMoney(promo.amountOffMinor ?? 0, currency)} off`;
  return promo.appliesPer === "ORDER" ? `${amount} the order` : `${amount} each ticket`;
}

/**
 * Promo codes for paid tickets: a percentage or amount off each ticket or
 * the whole order, optionally for one ticket, a minimum quantity, a limited
 * number of uses or a time window. A code is shown only while it's typed;
 * the server keeps a digest and its first letters.
 */
export function PromoCodesManager({ organisationSlug, target, currency, promoCodes, tickets }: {
  organisationSlug: string;
  /** The event, or the series whose dates and passes these cover. */
  target: TicketTarget;
  currency: string;
  promoCodes: ManagedPromoCode[];
  tickets: Array<{ id: string; name: string; priceMinor: number; }>;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [archiving, setArchiving] = useState<ManagedPromoCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const paidTickets = tickets.filter((ticket) => ticket.priceMinor > 0);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => (current ? { ...current, [key]: value } : current));

  function save() {
    if (!draft) return;
    setError(null);
    startTransition(async () => {
      const result = await createPromoCode({
        organisationSlug,
        ...target,
        code: draft.code,
        kind: draft.kind,
        appliesPer: draft.appliesPer,
        ...(draft.kind === "PERCENT" ? { percentOff: Number(draft.value) || null } : { amountOff: draft.value }),
        ticketTypeId: draft.ticketTypeId || null,
        minQuantity: Number(draft.minQuantity) || 1,
        perOrderLimit: draft.appliesPer === "TICKET" ? optionalNumber(draft.perOrderLimit) : null,
        maxRedemptions: optionalNumber(draft.maxRedemptions),
        validFrom: optionalIso(draft.validFrom),
        validUntil: optionalIso(draft.validUntil),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(null);
      showToast("Promo code added. Only its first letters are shown from now on, so note it down.", "success");
      router.refresh();
    });
  }

  if (paidTickets.length === 0 && promoCodes.length === 0) return null;
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="promo-title">
      <CardHeader
        title={<span id="promo-title">Promo codes</span>}
        description="Discounts on paid tickets. A 100% code makes them free. Codes are stored scrambled, so only their first letters are shown later."
        action={draft || paidTickets.length === 0 ? null : (
          <Button variant="secondary" startIcon={<Plus />} onClick={() => { setError(null); setDraft(EMPTY); }}>
            Add code
          </Button>
        )}
      />
      <div className="flex flex-col gap-4">
        {promoCodes.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {promoCodes.map((promo) => (
              <li key={promo.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-ink">
                    {promo.hint} <span className="font-normal text-ink-secondary">{describeDiscount(promo, currency)}</span>
                  </p>
                  <p className="text-caption text-ink-muted">
                    Used {promo.uses}{promo.maxRedemptions != null ? ` of ${promo.maxRedemptions}` : ""} {promo.uses === 1 && promo.maxRedemptions == null ? "time" : "times"}
                    {promo.ticketTypeId ? ` · ${tickets.find((ticket) => ticket.id === promo.ticketTypeId)?.name ?? "one ticket"} only` : ""}
                    {promo.minQuantity > 1 ? ` · ${promo.minQuantity}+ tickets` : ""}
                    {promo.perOrderLimit != null ? ` · up to ${promo.perOrderLimit} per order` : ""}
                    {promo.validFrom ? ` · from ${new Date(promo.validFrom).toLocaleString()}` : ""}
                    {promo.validUntil ? ` · until ${new Date(promo.validUntil).toLocaleString()}` : ""}
                  </p>
                </div>
                <Button size="sm" variant="dangerQuiet" onClick={() => setArchiving(promo)}>Stop code</Button>
              </li>
            ))}
          </ul>
        ) : null}
        {draft ? (
          <form className="flex flex-col gap-4 rounded-lg border border-line p-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
            {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
            <Field label="Code" required helperText="3 to 32 letters, numbers, dashes or underscores. Not case-sensitive.">
              <Input value={draft.code} maxLength={32} autoComplete="off" spellCheck={false} onChange={(event) => set("code", event.target.value.toUpperCase())} />
            </Field>
            <RadioGroup value={draft.kind} onValueChange={(value) => set("kind", value as Draft["kind"])} aria-label="Discount type" className="flex-row flex-wrap gap-6">
              <Radio value="PERCENT" label="Percent off" />
              <Radio value="FIXED" label={`Amount off (${currency})`} />
            </RadioGroup>
            <RadioGroup value={draft.appliesPer} onValueChange={(value) => set("appliesPer", value as Draft["appliesPer"])} aria-label="Applies to" className="flex-row flex-wrap gap-6">
              <Radio value="TICKET" label="Each ticket" />
              <Radio value="ORDER" label="The whole order, once" />
            </RadioGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={draft.kind === "PERCENT" ? "Percent" : "Amount"} required>
                <Input inputMode="decimal" value={draft.value} onChange={(event) => set("value", event.target.value)} />
              </Field>
              <Field label="Ticket" optional>
                <Dropdown value={draft.ticketTypeId} onChange={(event) => set("ticketTypeId", event.target.value)}>
                  <option value="">Any paid ticket</option>
                  {paidTickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.name}</option>)}
                </Dropdown>
              </Field>
              <Field label="Fewest tickets in the order" helperText="Group discounts: for example 5.">
                <Input type="number" min={1} max={100} value={draft.minQuantity} onChange={(event) => set("minQuantity", event.target.value)} />
              </Field>
              {draft.appliesPer === "TICKET" ? (
                <Field label="Discounted tickets per order" optional helperText="Blank: every eligible ticket.">
                  <Input type="number" min={1} max={100} value={draft.perOrderLimit} onChange={(event) => set("perOrderLimit", event.target.value)} />
                </Field>
              ) : null}
              <Field label="Orders that can use it" optional helperText="Blank: no limit.">
                <Input type="number" min={1} value={draft.maxRedemptions} onChange={(event) => set("maxRedemptions", event.target.value)} />
              </Field>
              <Field label="Works from" optional>
                <Input type="datetime-local" value={draft.validFrom} onChange={(event) => set("validFrom", event.target.value)} />
              </Field>
              <Field label="Works until" optional>
                <Input type="datetime-local" value={draft.validUntil} onChange={(event) => set("validUntil", event.target.value)} />
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" loading={pending} loadingLabel="Saving…">Add code</Button>
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </form>
        ) : null}
      </div>
      <ConfirmationDialog
        open={archiving != null}
        title="Stop this promo code?"
        message="It can't be used again. Orders that already used it keep their price."
        confirmLabel="Stop code"
        loading={pending}
        onCancel={() => setArchiving(null)}
        onConfirm={() => {
          if (!archiving) return;
          startTransition(async () => {
            const result = await archivePromoCode({ organisationSlug, ...target, promoCodeId: archiving.id });
            setArchiving(null);
            if (!result.ok) return showToast(result.error, "error");
            router.refresh();
          });
        }}
      />
    </Card>
  );
}

/**
 * When buyers may cancel paid tickets themselves for a refund. Each order
 * keeps the policy it was sold under; after the first sale it can only
 * become more generous.
 */
export function RefundPolicyControl({ organisationSlug, target, policy, sold }: {
  organisationSlug: string;
  /** The event, or the series whose dates and passes these cover. */
  target: TicketTarget;
  policy: RefundPolicySnapshot;
  /** Paid orders exist, so the policy can only loosen. */
  sold: boolean;
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [kind, setKind] = useState(policy.kind);
  const [hours, setHours] = useState(String(policy.hours ?? 48));
  const [percent, setPercent] = useState(String(policy.percent ?? 50));
  const [text, setText] = useState(policy.text);
  const [pending, startTransition] = useTransition();
  const preview: RefundPolicySnapshot = { kind, hours: kind === "NONE" ? null : Number(hours), percent: kind === "PERCENT_UNTIL" ? Number(percent) : null, text };
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="refund-policy-title">
      <CardHeader
        title={<span id="refund-policy-title">Refund policy</span>}
        action={<HelpLink article="payments/refunds" />}
        description={`For paid tickets. You can always refund a guest yourself from the guest list, in full or in part.${sold ? " Tickets have been sold, so the policy can only become more generous; each order keeps the policy it was bought under." : ""}`}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await saveRefundPolicy({
              organisationSlug, ...target, kind, text,
              hours: kind === "NONE" ? null : Number(hours),
              percent: kind === "PERCENT_UNTIL" ? Number(percent) : null,
            });
            if (!result.ok) return showToast(result.error, "error");
            showToast("Refund policy saved.", "success");
            router.refresh();
          });
        }}
      >
        <RadioGroup value={kind} onValueChange={(value) => setKind(value as RefundPolicySnapshot["kind"])} aria-label="Refund policy">
          <Radio value="NONE" label="Guests ask me for refunds" />
          <Radio value="FULL_UNTIL" label="Guests can cancel for a full refund" description="Automatic, until the time below." />
          <Radio value="PERCENT_UNTIL" label="Guests can cancel for part of the price back" description="Automatic, until the time below." />
        </RadioGroup>
        {kind !== "NONE" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Hours before the start" helperText="After this, guests ask you instead. 0: until it starts.">
              <Input type="number" min={0} max={8760} value={hours} onChange={(event) => setHours(event.target.value)} />
            </Field>
            {kind === "PERCENT_UNTIL" ? (
              <Field label="Percent refunded">
                <Input type="number" min={1} max={99} value={percent} onChange={(event) => setPercent(event.target.value)} />
              </Field>
            ) : null}
          </div>
        ) : null}
        <Field label="Anything else buyers should know" optional>
          <Textarea value={text} maxLength={1000} rows={2} onChange={(event) => setText(event.target.value)} />
        </Field>
        <p className="text-caption text-ink-muted">Buyers see: {describeRefundPolicy(preview)}</p>
        <div>
          <Button type="submit" variant="secondary" loading={pending} loadingLabel="Saving…">Save policy</Button>
        </div>
      </form>
    </Card>
  );
}

/** Whether holders may give their tickets to someone else, and until when. */
export function TransfersControl({ organisationSlug, target, transfers }: {
  organisationSlug: string;
  target: TicketTarget;
  transfers: { allow: boolean; cutoffHours: number; };
}) {
  const router = useRouter();
  const { showToast } = useToast();
  const [allow, setAllow] = useState(transfers.allow);
  const [hours, setHours] = useState(String(transfers.cutoffHours));
  const [pending, startTransition] = useTransition();
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="transfers-title">
      <CardHeader
        title={<span id="transfers-title">Ticket transfers</span>}
        description="Let buyers give a ticket to someone else from their order. The ticket gets a new link and the new holder is emailed it; the old link stops working."
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await saveTransferPolicy({ organisationSlug, ...target, allowTransfers: allow, cutoffHours: Number(hours) || 0 });
            if (!result.ok) return showToast(result.error, "error");
            showToast("Transfer setting saved.", "success");
            router.refresh();
          });
        }}
      >
        <CheckboxField checked={allow} onCheckedChange={(checked) => setAllow(checked === true)} label="Allow transfers" />
        {allow ? (
          <Field label="Until this many hours before the start" helperText="For a series, before each date's start.">
            <Input type="number" min={0} max={8760} value={hours} onChange={(event) => setHours(event.target.value)} />
          </Field>
        ) : null}
        <div><Button type="submit" loading={pending} loadingLabel="Saving…">Save</Button></div>
      </form>
    </Card>
  );
}

