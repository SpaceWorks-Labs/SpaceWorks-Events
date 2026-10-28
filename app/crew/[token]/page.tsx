import type { Metadata } from "next";
import { UsersRound } from "lucide-react";
import { loadCrewJoinView } from "@/lib/views/app__crew__token__page";
import { safeTimeZone } from "@/lib/timeZone";
import { formatDateBlock, formatDayLong } from "@/lib/format/datetime";
import { CrewJoinForm } from "@/components/crew/CrewJoinForm";
import { Callout, Chip, DateBlock } from "@/components/ui/display";

type Props = { params: Promise<{ token: string }> };

// The crew link is a bearer capability (docs/CREW.md): render per request,
// never cache or index it, and keep its URL out of Referer headers.
export const dynamic = "force-dynamic";

/** Deliberately generic: metadata never reveals the event or organisation. */
export const metadata: Metadata = {
  title: "Join the crew",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Crew sign-up link: `/crew/{token}`. */
export default async function CrewJoinPage({ params }: Props) {
  const page = await loadCrewJoinView({ params });
  const timeZone = safeTimeZone(page.timezone);
  const start = new Date(page.startDateTime);
  const dateBlock = formatDateBlock(start, timeZone);

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-6">
      <header className="flex flex-col gap-4">
        <div>
          <Chip tone="accent" size="sm" icon={<UsersRound aria-hidden className="size-3.5" />}>Crew sign-up</Chip>
        </div>
        <h1 className="text-display-m break-words text-ink">Join the crew for {page.eventTitle}</h1>
        <p className="text-body-l text-ink-secondary">by <span className="font-semibold text-ink">{page.organisationName}</span></p>
        <div className="flex items-center gap-4">
          <DateBlock month={dateBlock.month} day={dateBlock.day} />
          <p className="text-[17px] font-bold text-ink">{formatDayLong(start, timeZone)}</p>
        </div>
      </header>

      {page.open ? (
        <section aria-labelledby="crew-join-title" className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5">
          <h2 id="crew-join-title" className="text-h3 text-ink">Your crew profile</h2>
          <p className="text-body-ui text-ink-secondary">
            You’ll get a crew ticket by email for check-in. The organisers review crew profiles before they appear on the event page.
          </p>
          <CrewJoinForm token={page.token} foodSuggestions={page.foodSuggestions} />
        </section>
      ) : (
        <Callout tone="warning" title="Crew sign-ups are closed">
          This event is no longer taking crew sign-ups. If you think this is a mistake, contact the organisers.
        </Callout>
      )}
    </div>
  );
}
