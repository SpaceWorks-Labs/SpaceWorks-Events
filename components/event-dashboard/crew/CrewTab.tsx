"use client";

import { useState } from "react";
import { SegmentedControl } from "@/components/ui/choice";
import { GuestsCrew } from "@/components/event-dashboard/panels/GuestsCrew";
import { ShiftsPanel } from "@/components/event-dashboard/crew/shifts/ShiftsPanel";
import type { DashboardCrew } from "@/lib/eventDashboard/crew";
import type { DashboardVolunteerShifts } from "@/lib/eventDashboard/volunteerShifts";

/** Guests → Crew: the crew list (docs/CREW.md) and its volunteer shifts (docs/VOLUNTEERS.md). */
export function CrewTab({ organisationSlug, eventId, origin, crew, shifts, now }: {
  organisationSlug: string; eventId: string; origin: string; crew: DashboardCrew; shifts: DashboardVolunteerShifts; now: string;
}) {
  const [view, setView] = useState<"members" | "shifts">("members");
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SegmentedControl
        ariaLabel="Crew sections"
        size="sm"
        className="self-start"
        value={view}
        onValueChange={setView}
        options={[{ value: "members", label: "Members" }, { value: "shifts", label: shifts.enabled ? `Shifts ${shifts.shifts.length}` : "Shifts" }]}
      />
      {view === "members" ? (
        <GuestsCrew organisationSlug={organisationSlug} eventId={eventId} origin={origin} crew={crew} />
      ) : (
        <ShiftsPanel organisationSlug={organisationSlug} eventId={eventId} data={shifts} now={now} />
      )}
    </div>
  );
}
