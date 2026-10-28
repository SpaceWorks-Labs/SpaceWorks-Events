import { loadDiscoverView } from "@/lib/views/app__discover__page";
import Link from "next/link";
import { CalendarRange, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import type { Metadata } from "next";
import { MoodTile } from "@/components/brand/MoodTile";
import { DiscoverEventCard } from "@/components/discover/DiscoverEventCard";
import { Container } from "@/components/landing/primitives";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { controlClasses } from "@/components/ui/styles";
import { cn } from "@/lib/cn";
import { INK_ACCENT } from "@/lib/theme/accent";
import { describeRecurrence, recurrenceChip } from "@/lib/format/recurrence";
import { paginationWindow } from "@/lib/pagination";

export const metadata: Metadata = {
  title: "Discover Events",
  description:
    "Events from the communities on Space Works Events. Register in seconds, no account needed.",
};

const PAGE_SIZE = 12;

const MAX_QUERY_LENGTH = 120;

type SearchParams = Promise<{
  sort?: string;
  from?: string;
  to?: string;
  q?: string;
  page?: string;
}>;

function buildQueryString(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  return query.size ? `?${query}` : "";
}

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { sort, q, clearSearchHref, dateChips, activeRange, dateRangeError, sp, resultsLabel, totalItems, startIdx, pageItems, hasActiveFilters, goingByEvent, totalPages, safePage, getStartedHref } = await loadDiscoverView({ searchParams });

  const baseParams = {
    ...(q ? { q } : {}),
    ...(sort !== "upcoming" ? { sort } : {}),
    ...(sp.from ? { from: sp.from } : {}),
    ...(sp.to ? { to: sp.to } : {}),
  };
  const pageHref = (target: number) => `/discover${buildQueryString({ ...baseParams, page: String(target) })}`;
  const sortHref = (target: "upcoming" | "popular") => `/discover${buildQueryString({ ...(q ? { q } : {}), ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), ...(target !== "upcoming" ? { sort: target } : {}) })}`;
  const chipClasses = (active: boolean) =>
    cn(
      "inline-flex min-h-8 items-center rounded-full border px-3.5 text-[13px] font-semibold leading-[1.4] transition-colors",
      active ? "border-primary bg-primary text-on-primary" : "border-line-strong bg-panel text-ink hover:bg-surface",
    );
  return (
    <div className="flex min-w-0 flex-col">
      {/* Title and search (Figma 125:2367) */}
      <Container className="flex flex-col gap-6 pb-8 pt-12 lg:pt-16">
        <h1 className="font-accent text-[34px] font-medium leading-[1.1] text-ink sm:text-[40px]">Discover events</h1>
        <p className="max-w-[720px] text-body-l text-ink-secondary">Free workshops, meetups and build nights from the communities on Space Works Events. Register in seconds, no account needed.</p>
        <form action="/discover" method="get" role="search" className="flex flex-col gap-4">
          {sort !== "upcoming" ? <input type="hidden" name="sort" value={sort} /> : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative w-full min-w-0 sm:max-w-[560px]">
              <label htmlFor="discover-q" className="sr-only">Search events</label>
              <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-ink-muted" />
              <input
                id="discover-q"
                name="q"
                type="search"
                defaultValue={q}
                placeholder="Search events"
                maxLength={MAX_QUERY_LENGTH}
                className={cn(controlClasses, "h-[52px] rounded-full pl-[46px] pr-12 text-body [&::-webkit-search-cancel-button]:appearance-none")}
              />
              {q ? (
                <Link href={clearSearchHref} aria-label="Clear search" className="absolute right-2 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-ink-muted hover:text-ink">
                  <X aria-hidden className="size-4" />
                </Link>
              ) : null}
            </div>
            <Button type="submit" variant="primary" size="lg" className="h-[52px] shrink-0">Search</Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="When" className="flex flex-wrap gap-2">
              {dateChips.map((chip) => (
                <Link key={chip.key} href={chip.href} aria-current={activeRange === chip.key ? "true" : undefined} className={chipClasses(activeRange === chip.key)}>
                  {chip.label}
                </Link>
              ))}
            </nav>
            <details className="group" open={activeRange === "custom" || Boolean(dateRangeError)}>
              <summary className={cn(chipClasses(activeRange === "custom"), "cursor-pointer list-none gap-1.5 [&::-webkit-details-marker]:hidden")}>
                <CalendarRange aria-hidden className="size-3.5" />
                Pick dates
              </summary>
              <fieldset className="mt-3 flex flex-wrap items-end gap-2.5">
                <legend className="sr-only">Date range</legend>
                <label className="flex w-[170px] flex-col rounded-[18px] border border-line-strong bg-panel px-4 py-1.5 focus-within:border-[var(--yy-focus)]">
                  <span className="text-xs text-ink-muted">From</span>
                  <input name="from" type="date" defaultValue={sp.from ?? ""} className="bg-transparent text-[15px] text-ink outline-none" />
                </label>
                <label className="flex w-[170px] flex-col rounded-[18px] border border-line-strong bg-panel px-4 py-1.5 focus-within:border-[var(--yy-focus)]">
                  <span className="text-xs text-ink-muted">To</span>
                  <input name="to" type="date" defaultValue={sp.to ?? ""} className="bg-transparent text-[15px] text-ink outline-none" />
                </label>
                <Button type="submit" variant="secondary">Apply dates</Button>
              </fieldset>
            </details>
          </div>
        </form>
        {dateRangeError ? <Callout tone="warning" title={dateRangeError}>Date filtering was not applied.</Callout> : null}
      </Container>

      {/* Results (Figma 125:2391) */}
      <Container className="flex flex-col gap-6 pb-16 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 text-label text-ink-secondary [overflow-wrap:anywhere]" aria-live="polite">{resultsLabel}</h2>
          <div className="flex flex-wrap items-center gap-3">
            {totalItems > 0 ? (
              <p className="text-caption text-ink-muted">
                {startIdx + 1}–{Math.min(startIdx + PAGE_SIZE, totalItems)} of {totalItems}
              </p>
            ) : null}
            <nav aria-label="Sort events" className="flex rounded-full border border-line bg-surface p-1">
              {(["upcoming", "popular"] as const).map((option) => (
                <Link
                  key={option}
                  href={sortHref(option)}
                  aria-current={sort === option ? "true" : undefined}
                  className={cn(
                    "inline-flex min-h-8 items-center rounded-full px-3.5 text-[13px] font-semibold transition-colors",
                    sort === option ? "border border-line-strong bg-panel text-ink" : "border border-transparent text-ink-secondary hover:text-ink",
                  )}
                >
                  {option === "upcoming" ? "Upcoming" : "Popular"}
                </Link>
              ))}
            </nav>
          </div>
        </div>

        {pageItems.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-[16px] border border-line bg-panel px-6 py-10 text-center">
            <MoodTile mood="thinking" size={56} className="mb-2" />
            <p className="text-label text-ink">Nothing matches just yet</p>
            <p className="max-w-md text-body-ui text-ink-muted">Try a different search, or clear the filters to see every upcoming event.</p>
            {hasActiveFilters ? (
              <Button asChild variant="secondary" size="sm" className="mt-2">
                <Link href="/discover">Clear filters</Link>
              </Button>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {pageItems.map((row) => (
              // min-w-0: a long unbroken title must wrap, not widen the grid track.
              <li key={row.id} className="min-w-0">
                {row.kind === "event" ? (
                  <DiscoverEventCard
                    event={{
                      href: `/${row.orgSlug}/${row.event.slug}`,
                      title: row.event.title,
                      startDateTime: row.event.startDateTime,
                      timezone: row.event.timezone,
                      location: row.event.location,
                      isOnline: row.event.isOnline,
                      coverImageUrl: row.event.coverImageUrl,
                      accentColor: row.event.page?.accentColor,
                      organisationName: row.event.organisation.name,
                      label: row.event.tags[0] ?? null,
                      goingCount: row.event.showRegistrationCount ? goingByEvent.get(row.event.id) ?? 0 : null,
                    }}
                  />
                ) : (
                  <DiscoverEventCard
                    event={{
                      href: `/${row.orgSlug}/i/${row.instance.id}`,
                      title: row.instance.series.title,
                      startDateTime: row.instance.startDateTime,
                      timezone: row.instance.series.timezone,
                      fallbackAccent: INK_ACCENT,
                      organisationName: row.instance.series.organisation.name,
                      label: recurrenceChip(row.instance.series.recurrenceRule),
                      recurrenceText: describeRecurrence(row.instance.series.recurrenceRule),
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}

        {totalPages > 1 ? (
          <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
            {safePage > 1 ? (
              <Button asChild variant="secondary">
                <Link href={pageHref(safePage - 1)}><ChevronLeft aria-hidden className="size-4" />Previous</Link>
              </Button>
            ) : (
              <Button variant="secondary" disabled><ChevronLeft aria-hidden className="size-4" />Previous</Button>
            )}
            {paginationWindow(safePage, totalPages).map((p) => (
              <Link
                key={p}
                href={pageHref(p)}
                aria-current={p === safePage ? "page" : undefined}
                className={cn("inline-flex size-11 items-center justify-center rounded-full text-[15px] font-semibold", p === safePage ? "bg-primary text-on-primary" : "text-ink-secondary hover:bg-surface")}
              >
                {p}
              </Link>
            ))}
            {safePage < totalPages ? (
              <Button asChild variant="secondary">
                <Link href={pageHref(safePage + 1)}>Next<ChevronRight aria-hidden className="size-4" /></Link>
              </Button>
            ) : (
              <Button variant="secondary" disabled>Next<ChevronRight aria-hidden className="size-4" /></Button>
            )}
          </nav>
        ) : null}
      </Container>

      {/* Host your own (Figma 125:3219) */}
      <Container className="pb-16 lg:pb-[88px]">
        <div className="flex flex-col items-start gap-6 rounded-[16px] bg-sw-citron p-6 text-sw-ink sm:p-8 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h2 className="text-h3 text-sw-ink">Running something?</h2>
            <p className="max-w-[640px] text-body text-sw-ink">Set up your organisation and publish your first event in a few minutes.</p>
          </div>
          <Button asChild variant="primary" size="lg" className="shrink-0">
            <Link href={getStartedHref}>Start organising</Link>
          </Button>
        </div>
      </Container>
    </div>
  );
}
