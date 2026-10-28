"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/display";
import { SwitchRow } from "@/components/ui/choice";
import { updateMentorDeskSettings } from "@/app/actions/mentor-desk";
import { type DeskScope, ErrorLine, useDeskSave } from "../shared";

/**
 * Settings → Mentor Desk (docs/MENTOR_DESK.md), owners and admins: the
 * switch (off by default) and the optional "a mentor is on the way" email.
 * Mentors are invited above as co-organisers with the Mentor permission.
 * Turning the desk off removes access; nothing is deleted.
 */
export function MentorDeskSettingsCard({ scope, enabled, helpClaimedEmail, crewTicket }: { scope: DeskScope; enabled: boolean; helpClaimedEmail: boolean; crewTicket: boolean }) {
  const { pending, error, save } = useDeskSave();
  const [on, setOn] = useState(enabled);
  const [email, setEmail] = useState(helpClaimedEmail);
  const [crew, setCrew] = useState(crewTicket);
  return (
    <Card>
      <CardHeader title="Mentor Desk" description="A help queue, mentor assignments, office hours and mentoring rounds for teams. Mentors pass the authenticator check like other staff and never pay." />
      <div className="mt-4 flex flex-col gap-3.5">
        <SwitchRow label="Turn on the Mentor Desk" description="Adds the Mentors tab. When on, a judge who mentored a team is kept off it." checked={on} onCheckedChange={setOn} />
        <SwitchRow label="Email the team when a mentor picks up their request" description="Once per request, never for each change." checked={email} onCheckedChange={setEmail} />
        <SwitchRow label="Give mentors a crew ticket" description="Mentors who accept their invite from now on join the crew (role Mentor, not listed publicly) with a free crew ticket. Removing a mentor removes that ticket. Someone already registered keeps their own ticket." checked={crew} onCheckedChange={setCrew} />
        <ErrorLine error={error} />
        <Button variant="primary" className="self-start" loading={pending} onClick={() => save(() => updateMentorDeskSettings({ ...scope, mentorDeskEnabled: on, mentorHelpClaimedEmail: email, mentorsGetCrewTicket: crew }), "Mentor Desk settings saved.")}>Save</Button>
      </div>
    </Card>
  );
}
