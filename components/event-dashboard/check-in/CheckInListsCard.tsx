import Link from "next/link";
import { ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { CheckInListView } from "@/lib/eventDashboard/checkInLists";
import { ManageCheckInListsDialog } from "@/components/checkin/ManageCheckInListsDialog";
import { HelpLink } from "@/components/help/HelpLink";

const cardClass = "flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-panel p-5";

export function CheckInListsCard({ organisationSlug, eventId, lists, checkInHref, canManage, className, addOns = [] }: {
  organisationSlug: string;
  eventId: string;
  lists: CheckInListView[];
  /** The desk link, or null when the viewer cannot scan. */
  checkInHref: string | null;
  canManage: boolean;
  className?: string;
  /** Extras the event sells, for lists limited to their buyers. */
  addOns?: Array<{ id: string; name: string }>;
}) {
  const open = lists.filter((list) => !list.archived);
  return (
    <section aria-labelledby="checkin-lists-title" className={cn(cardClass, className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 id="checkin-lists-title" className="text-h4 text-ink">Check-in lists</h2>
          <HelpLink article="check-in/check-in-lists" />
        </div>
        {canManage ? <ManageCheckInListsDialog organisationSlug={organisationSlug} eventId={eventId} lists={lists} addOns={addOns} /> : null}
      </div>
      <p className="text-sm text-ink-secondary">
        Track more than the door: swag, meals or workshops. Each list counts who has collected it, separately from entry check-in.
      </p>
      {open.length === 0 ? (
        <p className="text-sm text-ink-muted">{canManage ? "No lists yet. Add one with Manage lists." : "No lists yet. Organisers with page editing rights can add them."}</p>
      ) : (
        <ul aria-label="Check-in lists" className="flex flex-col divide-y divide-line">
          {open.map((list) => (
            <li key={list.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold text-ink">{list.name}</p>
                <p className="text-caption text-ink-muted">
                  <span className="font-semibold text-ink">{list.collected}</span> / {list.eligible} collected
                  {list.requiresEntryCheckIn ? " · after entry check-in" : ""}
                  {list.addOn ? ` · buyers of ${list.addOn.name}` : ""}
                </p>
              </div>
              {checkInHref ? (
                <Button asChild size="sm" variant="secondary">
                  <Link href={`${checkInHref}?list=${encodeURIComponent(list.id)}`} aria-label={`Open ${list.name} check-in`}>
                    <ListChecks aria-hidden className="size-4" />
                    Open
                  </Link>
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
