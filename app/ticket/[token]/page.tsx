import { loadRouteMetadata } from "@/lib/views/app__ticket__token__page";
import { loadTicketView } from "@/lib/views/app__ticket__token__page";
import type { Metadata } from "next";
import Link from "next/link";
import { MoodTile } from "@/components/brand/MoodTile";
import { ArrowLeft, ArrowUpRight, BadgeCheck, CalendarPlus, Check } from "lucide-react";
import { TicketQrPanel } from "@/components/ticket/TicketQrPanel";
import { CancelRsvpButton } from "@/components/ticket/CancelRsvpButton";
import { TicketSeekerPanel, TicketTeamCard } from "@/components/team/TicketTeamSection";
import { TicketJoinTeamForm } from "@/components/team/JoinTeamWithRegistration";
import { TicketSubmissionCard } from "@/components/submission/TicketSubmissionCard";
import { TicketDownloadButton } from "@/components/ticket/TicketDownloadButton";
import { TicketClaims } from "@/components/ticket/TicketClaims";
import { TicketApplicationCard } from "@/components/ticket/TicketApplicationCard";
import { TicketStatusStorageSync } from "@/components/ticket/TicketStatusStorageSync";
import { HideAfterLiveCheckIn, LiveCheckedInChip, LiveTicketCard, LiveTicketProvider } from "@/components/ticket/LiveTicket";
import { googleCalendarEventUrl } from "@/lib/calendarInvite";
import { accentStyle } from "@/lib/theme/accent";
import { formatDayShort, formatTime, formatTimeZoneName } from "@/lib/format/datetime";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { ConfirmingPayment, PayNowButton } from "@/components/orders/OrderClient";

type Props = {
  params: Promise<{ token: string; }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> { return loadRouteMetadata({ params }); }

export default async function TicketPage({ params, searchParams }: Props) {
  const { isCrew, designedTicket, claims, application, teamSection, submissionMode, inTeam, rsvp, orgName, title, start, timeZone, location, mapHref, accent, calendarEvent, status, isCheckedIn, confirmed, name, eventPageHref, payment, hold, returningFromCheckout, otherDates } = await loadTicketView({ params, searchParams });
  const teamBlock = teamSection?.kind === "member" ? (
    <TicketTeamCard ticketToken={rsvp.checkInToken} team={teamSection.team} manageHref={teamSection.manageHref} canLeave={teamSection.canLeave} eventPageHref={eventPageHref} />
  ) : teamSection?.kind === "solo" ? (
    <>
      {teamSection.seeker ? <TicketSeekerPanel ticketToken={rsvp.checkInToken} profile={teamSection.seeker.profile} invites={teamSection.seeker.invites} requests={teamSection.seeker.requests} seekers={teamSection.seeker.seekers} teams={teamSection.seeker.teams} /> : null}
      {teamSection.canJoin ? <TicketJoinTeamForm ticketToken={rsvp.checkInToken} /> : null}
    </>
  ) : teamSection?.kind === "sign-in" ? (
    <Callout tone="info">Sign in to the account you registered with to join or find a team.</Callout>
  ) : null;

  const ticketMain = (
    <>
      <header className="bg-accent px-6 py-5 text-on-accent">
        <p className="text-sm font-semibold opacity-90">{orgName}</p>
        <h1 className="mt-1 break-words text-[26px] font-semibold leading-tight tracking-[-0.02em] text-on-accent">{title}</h1>
      </header>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-6 py-5">
        <div>
          <dt className="text-overline text-ink-muted">Date</dt>
          <dd className="text-[15px] font-bold text-ink">{formatDayShort(start, timeZone)}</dd>
        </div>
        <div>
          <dt className="text-overline text-ink-muted">Time</dt>
          <dd className="text-[15px] font-bold text-ink">{formatTime(start, timeZone)} {formatTimeZoneName(start, timeZone)}</dd>
        </div>
        {location ? (
          <div className="col-span-2">
            <dt className="text-overline text-ink-muted">Venue</dt>
            <dd className="break-words text-[15px] font-bold text-ink">
              {mapHref ? (
                <a
                  href={mapHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-4 decoration-accent hover:underline focus-visible:underline"
                >
                  {location}
                  <ArrowUpRight aria-hidden className="ml-0.5 inline-block size-4 align-[-2px] text-ink-muted" />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ) : (
                location
              )}
            </dd>
          </div>
        ) : null}
        <div className="col-span-2">
          <dt className="text-overline text-ink-muted">Guest</dt>
          <dd className="break-words text-[15px] font-bold text-ink">{name}</dd>
        </div>
        {payment ? (
          <div className="col-span-2">
            <dt className="text-overline text-ink-muted">{payment.ticketName ?? "Ticket"}</dt>
            <dd className="text-[15px] font-bold text-ink">{payment.status === "WAIVED" ? "Complimentary" : `${payment.amount}${payment.paid ? ", paid" : ""}`}{payment.testMode ? " (test payment)" : ""}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );

  return (
    <LiveTicketProvider
      token={rsvp.checkInToken}
      initialCheckedIn={isCheckedIn}
      initialCheckedInAt={rsvp.checkedInAt?.toISOString() ?? null}
      enabled={confirmed && !isCheckedIn}
    >
      <TicketStatusStorageSync checkInToken={rsvp.checkInToken} status={rsvp.status} />
      <div style={accentStyle(accent)} className="yy-accent-scope mx-auto flex w-full max-w-[400px] flex-col gap-4 py-2 sm:py-6">
        <div className="flex items-center justify-between gap-3">
          <Link href={eventPageHref} className="inline-flex min-h-10 items-center gap-1.5 text-[15px] font-semibold text-ink-secondary hover:text-ink">
            <ArrowLeft aria-hidden className="size-4" />
            Event page
          </Link>
          <div className="flex flex-wrap justify-end gap-1.5">
            {isCheckedIn ? <Chip tone="success" icon={<Check />}>Checked in</Chip> : <LiveCheckedInChip />}
            {isCrew ? <Chip tone="ink" icon={<BadgeCheck />}>Crew</Chip> : null}
            <Chip tone={status.tone} icon={confirmed ? <Check /> : undefined}>{status.label}</Chip>
          </div>
        </div>
        {confirmed ? (
          <div className="flex items-center gap-4">
            <MoodTile mood="cheering" size={64} />
            <p className="text-display-m break-words text-ink">{isCrew ? <>You&apos;re on the crew, {name}!</> : <>You&apos;re in, {name}!</>}</p>
          </div>
        ) : hold ? (
          <div className="flex items-center gap-4">
            <MoodTile mood="waiting" size={64} />
            <p className="text-display-m break-words text-ink">
              {hold.active ? `Almost there, ${name}.` : `Your held seat was released, ${name}.`}
            </p>
          </div>
        ) : rsvp.status === "WAITLISTED" || rsvp.status === "PENDING_APPROVAL" ? (
          <div className="flex items-center gap-4">
            <MoodTile mood="waiting" size={64} />
            <p className="text-display-m break-words text-ink">
              {rsvp.status === "WAITLISTED" ? `You're on the waitlist, ${name}.` : `Request sent, ${name}.`}
            </p>
          </div>
        ) : null}

        {/* Like the stub, the designed ticket (it carries the QR) is gone once checked in. */}
        {designedTicket && !isCheckedIn ? (
          <HideAfterLiveCheckIn>
            {/* eslint-disable-next-line @next/next/no-img-element -- a private, uncached render of this ticket */}
            <img src={`/api/ticket/${rsvp.checkInToken}/design?inline=1`} alt={`Your ticket for ${title}`} className="h-auto w-full rounded-xl border border-line" />
          </HideAfterLiveCheckIn>
        ) : null}

        {confirmed ? (
          // Once checked in, the QR is never rendered again: the card shows its torn, checked-in state.
          <LiveTicketCard main={ticketMain} stub={isCheckedIn ? null : <TicketQrPanel token={rsvp.checkInToken} />} timeZone={timeZone} />
        ) : (
          <article className="overflow-hidden rounded-xl border border-line bg-panel">
            {ticketMain}
            <div className="px-6 pb-6">
              {hold ? (
                hold.active ? (
                  <div className="flex flex-col gap-3">
                    {returningFromCheckout ? <ConfirmingPayment /> : null}
                    <Callout tone="info">
                      Your seat is held until <HoldTime iso={hold.expiresAt} timeZone={timeZone} />. Your ticket is confirmed as soon as the order is paid.
                    </Callout>
                    {hold.canPay ? <PayNowButton endpoint={`/api/ticket/${rsvp.checkInToken}/checkout`} /> : null}
                  </div>
                ) : (
                  <Callout tone="warning">
                    The time to pay ran out, so the seat went back on sale and nothing was charged. <Link href={eventPageHref} className="font-semibold underline underline-offset-4">Register again</Link> if seats are left.
                  </Callout>
                )
              ) : (
                <Callout tone={rsvp.status === "REJECTED" ? "danger" : "info"}>
                  {rsvp.status === "REJECTED"
                    ? "This registration wasn't approved, so there is no ticket."
                    : "A scannable ticket will be available after this registration is confirmed."}
                </Callout>
              )}
            </div>
          </article>
        )}

        {confirmed ? (
          <div className="grid grid-cols-2 gap-3">
            <Button asChild variant="primary" size="lg" fullWidth>
              <a href={googleCalendarEventUrl(calendarEvent)} target="_blank" rel="noreferrer" aria-label={`Add ${title} to Google Calendar`}>
                <CalendarPlus aria-hidden className="size-[18px] shrink-0" />
                Add to calendar
              </a>
            </Button>
            {isCheckedIn ? null : <TicketDownloadButton downloadUrl={`/api/ticket/${rsvp.checkInToken}/design`} pdfUrl={`/api/ticket/${rsvp.checkInToken}/design?format=pdf`} />}
          </div>
        ) : null}

        {otherDates.length > 0 ? (
          <section aria-labelledby="pass-dates" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
            <h2 id="pass-dates" className="text-h4 text-ink">Your other dates</h2>
            <ul className="flex flex-col divide-y divide-line">
              {otherDates.map((date) => (
                <li key={date.href} className="flex items-center justify-between gap-3 py-2 text-body-ui">
                  <span className={date.cancelled ? "text-ink-muted line-through" : "text-ink"}>
                    {formatDayShort(date.start, timeZone)} {formatTime(date.start, timeZone)}
                  </span>
                  {date.cancelled ? <Chip tone="neutral" size="sm">Cancelled</Chip> : <Link href={date.href} className="font-semibold text-ink underline underline-offset-4">Ticket</Link>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {application ? <TicketApplicationCard token={rsvp.checkInToken} view={application} /> : null}

        {teamBlock}

        {submissionMode ? <TicketSubmissionCard ticketToken={rsvp.checkInToken} mode={submissionMode} /> : null}

        {claims ? <TicketClaims ticketToken={rsvp.checkInToken} view={claims} /> : null}

        {/* Paid tickets are cancelled and refunded by the organiser; team members leave their team instead. */}
        {/* An application is withdrawn from its card above until its place is confirmed (docs/ADMISSION.md). */}
        {!isCheckedIn && rsvp.status !== "REJECTED" && !payment?.paid && !inTeam && !isCrew && (!application || application.status === "ACCEPTED") ? (
          <HideAfterLiveCheckIn>
            <CancelRsvpButton checkInToken={rsvp.checkInToken} eventPageHref={eventPageHref} />
          </HideAfterLiveCheckIn>
        ) : null}
      </div>
    </LiveTicketProvider>
  );
}

function HoldTime({ iso, timeZone }: { iso: string | null; timeZone: string; }) {
  if (!iso) return <>the hold ends</>;
  const date = new Date(iso);
  return <time dateTime={iso}>{formatTime(date, timeZone)} {formatTimeZoneName(date, timeZone)}</time>;
}
