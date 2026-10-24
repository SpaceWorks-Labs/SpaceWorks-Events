import Link from "next/link";
import { ArrowRight, Plus, ScanLine } from "lucide-react";
import { MoodTile, type Mood } from "@/components/brand/MoodTile";
import { Button } from "@/components/ui/button";
import { Avatar, Chip, DateBlock, OrgLogo } from "@/components/ui/display";
import type { DashboardHome, HomeActivity } from "@/lib/dashboardHome";
import { formatDateBlock, formatDayLong, formatRelativeDay, formatRelativeTime, formatTime } from "@/lib/format/datetime";
import { accentStyle } from "@/lib/theme/accent";
import { cn } from "@/lib/cn";
import { CopyEventLink } from "./CopyEventLink";
import { DotColumns, DotMeter, meterDots } from "./DotCharts";

export { FirstRunSetup } from "./HomeSections/FirstRunSetup";

/* ---------- Next up ---------- */

export function NextUpCard({ next, now }: { next: NonNullable<DashboardHome["next"]>; now: Date }) {
  const block = formatDateBlock(next.startDateTime, next.timezone);
  const when = formatRelativeDay(next.startDateTime, next.timezone, now).toUpperCase();
  const names = next.recentNames;
  const others = Math.max(0, next.confirmed - names.length);
  return (
    <section
      aria-labelledby="home-next-title"
      style={accentStyle(next.accent)}
      className="yy-accent-scope flex flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-raised md:flex-row"
    >
      <div className="yy-cover-placeholder relative flex min-h-[200px] flex-col justify-between gap-6 p-6 md:w-[44%] md:shrink-0 md:p-7">
        <span className="self-start rounded-full bg-sw-cream px-3 py-1 text-overline text-sw-ink">Next up · {when}</span>
        <div className="flex items-end gap-4">
          <DateBlock month={block.month} day={block.day} size="lg" tone="ink" className="border-white/40" />
          <h2 id="home-next-title" className={cn("line-clamp-3 min-w-0 font-display font-semibold leading-[1.05] tracking-[-0.02em] text-on-accent", next.title.length > 40 ? "text-[24px] sm:text-[26px]" : "text-[30px] sm:text-[34px]")}>
            {next.title}
          </h2>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-5 p-6 md:p-7">
        <p className="text-body-ui text-ink-secondary">
          {formatDayLong(next.startDateTime, next.timezone, now)} · {formatTime(next.startDateTime, next.timezone)}
          {next.location ? ` · ${next.location}` : ""}
        </p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-label text-ink">
              {next.confirmed} going
              {next.capacityUnits ? (
                <span className="font-normal text-ink-muted">
                  {" "}· {next.capacity ? `${next.capacityUnits.used} of ${next.capacity}` : next.capacityUnits.used} {next.capacityUnits.noun}
                </span>
              ) : next.capacity ? (
                <span className="font-normal text-ink-muted"> of {next.capacity}</span>
              ) : null}
            </p>
            {next.signupsLastDay > 0 ? <Chip tone="success" size="sm">+{next.signupsLastDay} in the last day</Chip> : null}
          </div>
          {next.capacity ? <DotMeter filled={meterDots(next.capacityUnits?.used ?? next.confirmed, next.capacity, 25)} total={25} color={next.accent} dot={11} className="!gap-[5px]" /> : null}
        </div>
        {names.length ? (
          <div className="flex items-center gap-3">
            <span className="flex">
              {names.map((name, index) => (
                <Avatar key={`${name}-${index}`} name={name} size="sm" tone={index % 2 ? "success" : "accent"} className="-ml-1.5 border-2 border-canvas first:ml-0" />
              ))}
            </span>
            <span className="text-caption text-ink-muted">
              {names.slice(0, 2).join(", ")}
              {others > 0 ? ` and ${others} other${others === 1 ? "" : "s"}` : names.length > 2 ? ` and ${names.length - 2} more` : ""}
            </span>
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap gap-2.5">
          {next.checkInHref ? (
            <Button asChild variant="accent">
              <Link href={next.checkInHref}>
                <ScanLine aria-hidden className="size-[18px]" />
                Open check-in
              </Link>
            </Button>
          ) : null}
          {next.href ? (
            <Button asChild variant="secondary">
              <Link href={next.href}>Manage event</Link>
            </Button>
          ) : null}
          {next.publicPath ? <CopyEventLink path={next.publicPath} title={next.title} /> : null}
        </div>
      </div>
    </section>
  );
}

/* ---------- Event day ---------- */

export function LiveEventPanel({ live, now }: { live: NonNullable<DashboardHome["live"]>; now: Date }) {
  const seats = Math.min(Math.max(live.confirmed, 1), 96);
  const lit = live.confirmed > 0 ? Math.round((Math.min(live.checkedIn, live.confirmed) / live.confirmed) * seats) : 0;
  const toCome = Math.max(0, live.confirmed - live.checkedIn);
  const busiest = Math.max(0, ...live.arrivals.map((bucket) => bucket.count));
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="home-live-title" className="yy-dark-band flex flex-col gap-8 rounded-xl bg-[var(--yy-inverse-surface)] p-6 text-ink sm:p-8 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <span className="inline-flex items-center gap-2 self-start rounded-full bg-success-bg px-3 py-1 text-overline text-success-fg">
            <span aria-hidden className="size-2 rounded-full bg-success-solid" />
            {live.started ? `Happening now · started ${formatTime(live.startDateTime, live.timezone)}` : `Today · starts ${formatTime(live.startDateTime, live.timezone)}`}
          </span>
          <h2 id="home-live-title" className="font-display text-[34px] font-semibold leading-[1.02] tracking-[-0.03em] text-ink sm:text-[44px]">{live.title}</h2>
          <p className="text-body-ui text-ink-secondary">
            {live.location ? `${live.location} · ` : ""}until {formatTime(live.endDateTime, live.timezone)}
          </p>
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-display text-[56px] font-semibold leading-none text-ink">{live.checkedIn}</span>
            <span className="text-body text-ink-secondary">
              of {live.confirmed} checked in{toCome > 0 ? ` · ${toCome} still to come` : ""}
            </span>
          </p>
          <div className="flex flex-wrap gap-2.5">
            {live.checkInHref ? (
              <Button asChild variant="inverse" size="lg">
                <Link href={live.checkInHref}>
                  <ScanLine aria-hidden className="size-5" />
                  Open check-in
                </Link>
              </Button>
            ) : null}
            {live.href ? (
              <Button asChild variant="secondary" size="lg">
                <Link href={live.href}>Manage event</Link>
              </Button>
            ) : null}
          </div>
        </div>
        <div aria-hidden className="grid w-full max-w-[340px] grid-cols-12 gap-[7px] self-center">
          {Array.from({ length: seats }, (_, index) => (
            <span key={index} className={cn("aspect-square rounded-full", index < lit ? "bg-brand-marigold" : "bg-brand-dot-off")} />
          ))}
        </div>
      </section>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {live.onStage.now || live.onStage.next ? (
          <section aria-labelledby="home-stage-title" className="flex flex-col gap-3.5 rounded-xl border border-line bg-panel p-5">
            <h3 id="home-stage-title" className="text-h4 text-ink">On stage</h3>
            {live.onStage.now ? (
              <div className="flex flex-col gap-1 rounded-lg bg-tint-peach px-4 py-3">
                <span className="text-overline text-ink-muted">Now · {formatTime(live.onStage.now.start, live.timezone)}–{formatTime(live.onStage.now.end, live.timezone)}</span>
                <span className="text-[17px] font-bold text-ink">{live.onStage.now.title}</span>
              </div>
            ) : null}
            {live.onStage.next ? (
              <div className="flex flex-col px-4">
                <span className="text-caption text-ink-muted">Next · {formatTime(live.onStage.next.start, live.timezone)}</span>
                <span className="font-semibold text-ink">{live.onStage.next.title}</span>
              </div>
            ) : null}
            {live.scheduleHref ? (
              <Link href={live.scheduleHref} className="mt-auto self-start text-sm font-semibold text-ink underline-offset-4 hover:underline">
                Live schedule
              </Link>
            ) : null}
          </section>
        ) : null}

        <section aria-labelledby="home-arrivals-title" className="flex flex-col gap-3.5 rounded-xl border border-line bg-panel p-5">
          <h3 id="home-arrivals-title" className="text-h4 text-ink">Arrivals</h3>
          <div className="flex items-end gap-1">
            {live.arrivals.map((bucket, index) => (
              <span key={bucket.label.toISOString()} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <DotColumns levels={[busiest ? Math.ceil((bucket.count / busiest) * 6) : 0]} max={6} tone="success" dot={11} />
                {/* Every other label, without AM/PM, so times never collide on narrow cards. */}
                <span className="min-h-[1.4em] whitespace-nowrap text-[11px] text-ink-muted">{index % 2 === 0 ? formatTime(bucket.label, live.timezone).replace(/ (AM|PM)$/, "") : ""}</span>
              </span>
            ))}
          </div>
          <p className="text-caption text-ink-muted">
            {busiest > 0 ? `Check-ins per 15 minutes. Busiest: ${busiest}.` : "No check-ins yet. Arrivals show here in 15-minute steps."}
          </p>
        </section>

        <section aria-labelledby="home-door-title" className="flex flex-col gap-1 rounded-xl border border-line bg-panel p-5">
          <h3 id="home-door-title" className="mb-1.5 text-h4 text-ink">At the door</h3>
          {live.door.length ? (
            <ul className="flex flex-col">
              {live.door.map((entry) => (
                <li key={entry.key} className="flex items-center gap-3 border-b border-line py-2 last:border-b-0">
                  <MoodTile mood="wink" size={24} className="yy-face" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink"><strong>{entry.who}</strong> checked in</span>
                  <span className="shrink-0 text-caption text-ink-muted">{formatRelativeTime(entry.at, live.timezone, now)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-body-ui text-ink-muted">Nobody checked in yet.</p>
          )}
        </section>
      </div>
    </div>
  );
}

/* ---------- Activity ---------- */

const ACTIVITY: Record<HomeActivity["kind"], { mood: Mood; text: string }> = {
  registered: { mood: "cheering", text: "registered" },
  waitlisted: { mood: "waiting", text: "joined the waitlist" },
  pending: { mood: "thinking", text: "asked to join" },
  checkedIn: { mood: "wink", text: "checked in" },
  feedback: { mood: "love", text: "sent feedback" },
};

export function ActivityFeed({ activity, now }: { activity: HomeActivity[]; now: Date }) {
  return (
    <section aria-labelledby="home-activity-title" className="flex min-w-0 flex-col gap-2 rounded-xl border border-line bg-panel p-5">
      <h2 id="home-activity-title" className="text-h4 text-ink">Activity</h2>
      {activity.length === 0 ? (
        <p className="py-2 text-body-ui text-ink-muted">Registrations, check-ins and feedback will show up here.</p>
      ) : (
        <ul className="flex flex-col">
          {activity.map((item) => (
            <li key={item.key} className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0">
              <MoodTile mood={ACTIVITY[item.kind].mood} size={32} className="yy-face" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm text-ink">
                  <strong>{item.who}</strong> {ACTIVITY[item.kind].text}
                </span>
                <span className="truncate text-caption text-ink-muted">{item.eventTitle}</span>
              </span>
              <span className="shrink-0 text-caption text-ink-muted">{formatRelativeTime(item.at, item.timezone, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---------- Stats ---------- */

export function StatRow({ stats }: { stats: DashboardHome["stats"] }) {
  return (
    <section aria-label="At a glance" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-line bg-panel px-5 py-4">
          <span className="text-sm text-ink-muted">{stat.label}</span>
          <span className="flex items-end justify-between gap-3">
            <span className="font-display text-[34px] font-semibold leading-none text-ink">{stat.value}</span>
            <DotColumns levels={stat.levels} tone={stat.tone} />
          </span>
          <span className="truncate text-caption text-ink-muted">{stat.hint}</span>
        </div>
      ))}
    </section>
  );
}

/* ---------- Organisations ---------- */

export function OrganisationCards({ organisations }: { organisations: DashboardHome["organisations"] }) {
  return (
    <section aria-labelledby="home-orgs-title" className="flex flex-col gap-3">
      <h2 id="home-orgs-title" className="text-h4 text-ink">Organisations</h2>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {organisations.map((organisation) => (
          <li key={organisation.id}>
            <Link href={`/dashboard/${organisation.slug}`} className="group flex h-full flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:bg-subtle">
              <span aria-hidden className="yy-dot-strip h-14" />
              <span className="flex flex-1 flex-col gap-2.5 px-5 pb-5">
                <OrgLogo name={organisation.name} src={organisation.logoUrl} size="lg" className="-mt-7 border-[3px] border-canvas" />
                <span className="truncate text-[17px] font-bold text-ink">{organisation.name}</span>
                <span className="flex flex-wrap gap-1.5">
                  <Chip size="sm">{organisation.upcoming} upcoming</Chip>
                  <Chip size="sm">{organisation.members} {organisation.members === 1 ? "member" : "members"}</Chip>
                  <Chip size="sm">{organisation.role}</Chip>
                </span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-semibold text-ink-secondary group-hover:text-ink">
                  Open workspace
                  <ArrowRight aria-hidden className="size-4" />
                </span>
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            href="/dashboard/org/new"
            className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-line-strong text-sm font-semibold text-ink-secondary transition-colors hover:bg-subtle hover:text-ink"
          >
            <Plus aria-hidden className="size-5" />
            New organisation
          </Link>
        </li>
      </ul>
    </section>
  );
}

