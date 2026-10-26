"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { assignTicketDesignAction, createTicketDesignAction, deleteTicketDesignAction } from "@/app/actions/ticket-designs";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader } from "@/components/ui/display";
import { Dropdown, Field } from "@/components/ui/field";

type Option = { id: string; name: string; };

/**
 * Settings → Ticket design (docs/TICKET_DESIGNER.md): the event's own designs,
 * which one the event and each ticket type use, and a new design from a
 * library template or a starter. Tickets fall back to the organisation's
 * default, then the built-in design.
 */
export function TicketDesignCard({ organisationSlug, eventId, eventDesignId, fallbackName, designs, library, ticketTypes, starters }: {
  organisationSlug: string;
  eventId: string;
  eventDesignId: string | null;
  fallbackName: string;
  designs: Option[];
  library: Option[];
  ticketTypes: Array<{ id: string; name: string; designId: string | null; }>;
  starters: Array<{ key: string; label: string; }>;
}) {
  const router = useRouter();
  const [source, setSource] = useState(library[0] ? `template:${library[0].id}` : `starter:${starters[0]?.key ?? "classic"}`);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (task: () => Promise<{ ok: boolean; error?: string; data?: unknown; }>, after?: (data: unknown) => Promise<void> | void) => {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (!result.ok) return setError(result.error ?? "Couldn't save that.");
      await after?.(result.data);
      router.refresh();
    });
  };
  const assign = (target: "event" | "ticketType", designId: string | null, ticketTypeId?: string) => run(() => assignTicketDesignAction({ organisationSlug, target, eventId, ticketTypeId: ticketTypeId ?? null, designId }));
  const create = () => {
    const [kind, value] = source.split(":") as ["template" | "starter", string];
    const name = kind === "template" ? `${library.find((design) => design.id === value)?.name ?? "Ticket"} (this event)` : "Event ticket";
    run(() => createTicketDesignAction({ organisationSlug, eventId, name, ...(kind === "template" ? { fromDesignId: value } : { starter: value }) }), async (data) => {
      const id = (data as { id: string; }).id;
      // The event's first design becomes its design straight away.
      if (!eventDesignId) await assignTicketDesignAction({ organisationSlug, target: "event", eventId, designId: id });
      router.push(`/dashboard/${organisationSlug}/ticket-designs/${id}`);
    });
  };
  return (
    <Card as="section" className="rounded-xl" aria-labelledby="ticket-design-title">
      <CardHeader title={<span id="ticket-design-title">Ticket design</span>} description="How tickets look on the ticket page, as downloads and in the confirmation email. Every design keeps the check-in QR code." />
      <div className="flex flex-col gap-4">
        {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
        <Field label="This event's tickets">
          <Dropdown value={eventDesignId ?? ""} disabled={pending} onChange={(event) => assign("event", event.target.value || null)}>
            <option value="">{fallbackName}</option>
            {designs.map((design) => <option key={design.id} value={design.id}>{design.name}</option>)}
          </Dropdown>
        </Field>
        {designs.length > 0 && ticketTypes.length > 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-label text-ink">A different design for a ticket</p>
            {ticketTypes.map((type) => (
              <Field key={type.id} label={type.name}>
                <Dropdown value={type.designId ?? ""} disabled={pending} onChange={(event) => assign("ticketType", event.target.value || null, type.id)}>
                  <option value="">Same as the event</option>
                  {designs.map((design) => <option key={design.id} value={design.id}>{design.name}</option>)}
                </Dropdown>
              </Field>
            ))}
          </div>
        ) : null}
        {designs.length > 0 ? (
          <ul aria-label="This event's designs" className="flex flex-col divide-y divide-line">
            {designs.map((design) => (
              <li key={design.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-body-ui text-ink">{design.name}</span>
                <Button asChild size="sm" variant="secondary"><Link href={`/dashboard/${organisationSlug}/ticket-designs/${design.id}`}><Pencil aria-hidden className="size-4" />Edit</Link></Button>
                <Button size="sm" variant="quiet" startIcon={<Trash2 aria-hidden />} disabled={pending} onClick={() => run(() => deleteTicketDesignAction({ organisationSlug, designId: design.id }))}>Delete</Button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field label="New design, starting from" className="flex-1">
            <Dropdown value={source} onChange={(event) => setSource(event.target.value)}>
              {library.map((design) => <option key={design.id} value={`template:${design.id}`}>Template: {design.name}</option>)}
              {starters.map((starter) => <option key={starter.key} value={`starter:${starter.key}`}>Starter: {starter.label}</option>)}
            </Dropdown>
          </Field>
          <Button startIcon={<Plus aria-hidden />} loading={pending} loadingLabel="Creating…" onClick={create}>Design a ticket</Button>
        </div>
        <p className="flex items-center gap-1.5 text-caption text-ink-muted"><Download aria-hidden className="size-3.5" />Attendees can save their ticket as PNG or PDF; confirmed guests also get the PDF with their confirmation email.</p>
      </div>
    </Card>
  );
}
