"use client";

import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/display";
import { bookOfficeHourAction, cancelOfficeHourBookingAction } from "@/app/actions/mentor-help";
import type { ParticipantDeskView } from "@/lib/core/mentorDesk/readsParticipant";
import { ErrorLine, type ParticipantRef, useDeskSave, When } from "../shared";

/**
 * The event's mentors (those who chose to be listed) and office hours. Teams
 * book a place; the team and the mentor get a calendar invite. A booking can
 * be cancelled until the slot starts.
 */
export function MentorsCard({ deskRef, view }: { deskRef: ParticipantRef; view: ParticipantDeskView }) {
  const { pending, error, save } = useDeskSave();
  if (view.mentors.length === 0 && !view.isTeam) return null;
  return (
    <section aria-labelledby="mentors-card" className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4">
      <h2 id="mentors-card" className="text-h4 text-ink">Mentors and office hours</h2>
      {view.mentors.length ? (
        <ul className="flex flex-col gap-2">
          {view.mentors.map((m) => (
            <li key={m.id} className="flex flex-col gap-0.5">
              <span className="text-label text-ink">{m.name}</span>
              {m.skills.length ? <span className="text-caption text-ink-muted">{m.skills.join(" · ")}</span> : null}
              {m.bio ? <p className="text-caption text-ink-secondary">{m.bio}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {view.isTeam ? (
        <>
          {view.bookings.length ? (
            <div className="flex flex-col gap-1.5">
              <h3 className="text-label text-ink">Your bookings</h3>
              <ul className="flex flex-col gap-1.5">
                {view.bookings.map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 text-body-ui text-ink-secondary">
                    <When iso={b.startsAt} timeZone={view.timezone} /> with {b.mentorName}{b.location ? ` · ${b.location}` : ""}
                    {!b.started ? <Button size="sm" variant="ghost" loading={pending} onClick={() => save(() => cancelOfficeHourBookingAction({ ...deskRef, bookingId: b.id }), "Booking cancelled.")}>Cancel</Button> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-label text-ink">Open office hours</h3>
            {view.slots.length === 0 ? <p className="text-caption text-ink-muted">No open slots right now.</p> : (
              <ul className="flex flex-col gap-1.5">
                {view.slots.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-body-ui text-ink-secondary">
                    <When iso={s.startsAt} timeZone={view.timezone} /> with {s.mentorName}{s.location ? ` · ${s.location}` : ""}
                    <Chip size="sm" tone="outline">{s.placesLeft} left</Chip>
                    <Button size="sm" variant="secondary" loading={pending} onClick={() => save(() => bookOfficeHourAction({ ...deskRef, slotId: s.id, expectedVersion: s.version }), "Booked. Check your email for the invite.")}>Book</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
      <ErrorLine error={error} />
    </section>
  );
}
