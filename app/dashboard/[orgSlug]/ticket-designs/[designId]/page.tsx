import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { loadTicketDesignerView } from "@/lib/views/app__dashboard__orgSlug__ticket-designs__designId__page";
import { TicketDesigner } from "@/components/ticket-designer/TicketDesigner";

type Props = { params: Promise<{ orgSlug: string; designId: string; }>; };

export const metadata: Metadata = { title: "Ticket designer", robots: { index: false, follow: false } };

/** The ticket designer (docs/TICKET_DESIGNER.md). */
export default async function TicketDesignerPage({ params }: Props) {
  const { organisationSlug, design, back, attendees } = await loadTicketDesignerView({ params });
  return (
    <div className="flex flex-col gap-5">
      <Link href={back.href} className="inline-flex items-center gap-1.5 text-overline text-ink-muted hover:text-ink">
        <ArrowLeft aria-hidden className="size-4" />
        {back.label}
      </Link>
      <TicketDesigner designId={design.id} organisationSlug={organisationSlug} name={design.name} initial={design.document} attendees={attendees} />
    </div>
  );
}
