"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Chip, EmptyState } from "@/components/ui/display";
import { Dropdown, Field, Input } from "@/components/ui/field";
import { cancelOfficeHourBookingAsOrganiser, cancelOfficeHourSlotAsOrganiser, createOfficeHourSlotAsOrganiser } from "@/app/actions/mentor-desk";
import { cancelOwnOfficeHourSlot, createOwnOfficeHourSlot } from "@/app/actions/mentor-console";
import { OFFICE_HOUR_CAPACITY_MAX, OFFICE_HOUR_LOCATION_MAX_LENGTH } from "@/lib/mentorDesk/rules";
import { type DeskScope, ErrorLine, useDeskSave, When } from "./shared";

export type SlotRow = { id: string; version: number; startsAt: string; endsAt: string; location: string; capacity: number; cancelled?: boolean; mentorName?: string; bookings: Array<{ id?: string; teamName: string }> };

/**
 * Office-hour slots: create one (inside the mentor's availability and the
 * event, no overlap with their other slots), cancel it with a reason (the
 * booked teams are emailed). Organisers can also cancel single bookings.
 */
export function SlotEditor({ scope, slots, timeZone, bounds, as, mentors }: {
  scope: DeskScope; slots: SlotRow[]; timeZone: string; bounds: { start: string; end: string };
  as: "organiser" | "mentor"; mentors?: Array<{ userId: string; name: string }>;
}) {
  const { pending, error, save } = useDeskSave();
  const [mentorUserId, setMentor] = useState(mentors?.[0]?.userId ?? "");
  const [start, setStart] = useState(bounds.start);
  const [end, setEnd] = useState(bounds.start);
  const [location, setLocation] = useState("");
  const [capacity, setCapacity] = useState("1");
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3 rounded-lg border border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const input = { ...scope, start, end, location, capacity: Number(capacity) };
          save(() => (as === "organiser" ? createOfficeHourSlotAsOrganiser({ ...input, mentorUserId }) : createOwnOfficeHourSlot(input)), "Slot added.");
        }}
      >
        <h3 className="text-h4 text-ink">New office-hour slot ({timeZone})</h3>
        {as === "organiser" ? (
          <Field label="Mentor">
            <Dropdown value={mentorUserId} onChange={(e) => setMentor(e.target.value)}>
              {mentors?.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </Dropdown>
          </Field>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Field label="Starts"><Input type="datetime-local" min={bounds.start} max={bounds.end} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Ends"><Input type="datetime-local" min={bounds.start} max={bounds.end} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Field label="Teams per slot"><Input type="number" min={1} max={OFFICE_HOUR_CAPACITY_MAX} value={capacity} onChange={(e) => setCapacity(e.target.value)} className="max-w-28" /></Field>
        </div>
        <Field label="Where" optional><Input value={location} maxLength={OFFICE_HOUR_LOCATION_MAX_LENGTH} onChange={(e) => setLocation(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <Button type="submit" variant="primary" loading={pending} className="self-start">Add slot</Button>
      </form>
      {slots.length === 0 ? <EmptyState title="No slots yet">Teams book office hours from their team page.</EmptyState> : (
        <ul className="flex flex-col gap-2">{slots.map((slot) => <SlotItem key={slot.id} scope={scope} slot={slot} timeZone={timeZone} as={as} />)}</ul>
      )}
    </div>
  );
}

function SlotItem({ scope, slot, timeZone, as }: { scope: DeskScope; slot: SlotRow; timeZone: string; as: "organiser" | "mentor" }) {
  const { pending, error, save } = useDeskSave();
  const [reason, setReason] = useState("");
  const cancelSlot = as === "organiser" ? cancelOfficeHourSlotAsOrganiser : cancelOwnOfficeHourSlot;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label text-ink"><When iso={slot.startsAt} timeZone={timeZone} /> – <When iso={slot.endsAt} timeZone={timeZone} /></span>
        {slot.mentorName ? <span className="text-body-ui text-ink-secondary">{slot.mentorName}</span> : null}
        <Chip size="sm" tone={slot.cancelled ? "neutral" : slot.bookings.length >= slot.capacity ? "warning" : "success"}>{slot.cancelled ? "Cancelled" : `${slot.bookings.length} / ${slot.capacity} booked`}</Chip>
        {slot.location ? <span className="text-caption text-ink-muted">{slot.location}</span> : null}
      </div>
      {slot.bookings.length ? (
        <ul className="flex flex-wrap gap-2">
          {slot.bookings.map((b, i) => (
            <li key={b.id ?? i} className="flex items-center gap-1.5 text-caption text-ink-secondary">
              {b.teamName}
              {as === "organiser" && b.id ? <Button size="sm" variant="dangerQuiet" loading={pending} onClick={() => save(() => cancelOfficeHourBookingAsOrganiser({ ...scope, bookingId: b.id }), "Booking cancelled.")}>Cancel</Button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!slot.cancelled ? (
        <div className="flex flex-wrap gap-2">
          <Input aria-label="Reason for cancelling" placeholder="Reason (logged)" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} className="max-w-64" />
          <Button size="sm" variant="dangerOutline" disabled={!reason.trim()} loading={pending} onClick={() => save(() => cancelSlot({ ...scope, slotId: slot.id, expectedVersion: slot.version, reason }), "Slot cancelled.")}>Cancel slot</Button>
        </div>
      ) : null}
      <ErrorLine error={error} />
    </li>
  );
}
