import type { Metadata } from "next";
import { loadTicketDesignLibraryView } from "@/lib/views/app__dashboard__orgSlug__ticket-designs__page";
import { DesignLibrary } from "@/components/ticket-designer/DesignLibrary";

type Props = { params: Promise<{ orgSlug: string; }>; };

export const metadata: Metadata = { title: "Ticket designs", robots: { index: false, follow: false } };

/** The organisation's ticket design library (docs/TICKET_DESIGNER.md). */
export default async function TicketDesignsPage({ params }: Props) {
  const { organisation, designs, defaultId, starters } = await loadTicketDesignLibraryView({ params });
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-h1 text-ink">Ticket designs</h1>
        <p className="mt-1 max-w-[680px] text-body-ui text-ink-muted">
          Templates for {organisation.name}&apos;s tickets. The default is used by every event until the event picks its own design; each event can also give a ticket type its own design.
        </p>
      </div>
      <DesignLibrary organisationSlug={organisation.slug} designs={designs} defaultId={defaultId} starters={starters} />
    </div>
  );
}
