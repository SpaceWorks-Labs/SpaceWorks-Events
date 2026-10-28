"use client";

import { useState } from "react";
import { saveApplicationSettings, setApplicationsEnabled } from "@/app/actions/admission";
import { Button } from "@/components/ui/button";
import { Radio, RadioGroup, SwitchRow } from "@/components/ui/choice";
import { Callout, Card, CardHeader, StatTile } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/field";
import { HelpLink } from "@/components/help/HelpLink";
import { useAdmissionAction, type AdmissionData, type AdmissionScope } from "./shared";

/**
 * Applications → Overview: the numbers, the settings (mode, days to answer,
 * offer capacity, the stage email switch) and turning applications off.
 */
export function ApplicationSettings({ scope, data, isAdmin }: { scope: AdmissionScope; data: AdmissionData; isAdmin: boolean }) {
  const { run, busy } = useAdmissionAction();
  const s = data.settings;
  const [mode, setMode] = useState<"MANUAL" | "AUTO">(s.mode);
  const [days, setDays] = useState(String(s.rsvpDays));
  const [capacity, setCapacity] = useState(s.offerCapacity == null ? "" : String(s.offerCapacity));
  const [emailOnStage, setEmailOnStage] = useState(s.emailOnStageAdvance);
  const count = (status: string) => data.applications.filter((app) => app.status === status).length;
  const total = data.applications.length;

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Applications" value={total} />
        <StatTile label="In review" value={count("IN_REVIEW")} />
        <StatTile label="Offers out" value={s.ceiling == null ? s.holding : `${s.holding} / ${s.ceiling}`} hint="Offered and accepted" progress={s.ceiling ? { value: s.holding, max: s.ceiling } : undefined} />
        <StatTile label="Waitlist" value={count("WAITLISTED")} />
      </div>
      <Card>
        <CardHeader title="How applications work here" description="Every registration is an application. Reviewers score it in stages, you release decisions in batches, and an offer is confirmed once the applicant accepts it (and pays, for a paid ticket)." action={<HelpLink article="applications/overview" />} />
        {!isAdmin ? <Callout tone="info">Only organisation owners and admins can change these settings.</Callout> : null}
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            run("save", () => saveApplicationSettings({ ...scope, mode, rsvpDays: Number(days), offerCapacity: capacity.trim() ? Number(capacity) : null, emailOnStageAdvance: emailOnStage }), "Application settings saved.");
          }}
        >
          <Field label="Decisions">
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as "MANUAL" | "AUTO")} disabled={!isAdmin}>
              <Radio value="MANUAL" label="Reviewed" description="You release decisions in batches after review." />
              <Radio value="AUTO" label="First come, first served" description="Each application is offered a place as it arrives, then the waitlist." />
            </RadioGroup>
          </Field>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Days to accept an offer" helperText="1 to 30 days; never past the event start.">
              <Input type="number" min={1} max={30} value={days} onChange={(event) => setDays(event.target.value)} disabled={!isAdmin} />
            </Field>
            <Field label="Most offers out at once" optional helperText={s.capacity ? `Leave empty to use the event capacity (${s.capacity}).` : "Leave empty for no limit."}>
              <Input type="number" min={1} value={capacity} onChange={(event) => setCapacity(event.target.value)} disabled={!isAdmin} />
            </Field>
          </div>
          <SwitchRow label="Email applicants when they move to the next stage" description="Off by default. Offers, reminders, waitlist places and decisions are always emailed." checked={emailOnStage} onCheckedChange={setEmailOnStage} disabled={!isAdmin} />
          {isAdmin ? <div><Button type="submit" loading={busy === "save"}>Save settings</Button></div> : null}
        </form>
      </Card>
      {isAdmin && total === 0 ? (
        <Card>
          <CardHeader title="Turn applications off" description="Possible until the first person applies. Registration then works as before, approval-only." />
          <Button variant="secondary" className="mt-3" loading={busy === "off"} onClick={() => run("off", () => setApplicationsEnabled({ ...scope, enabled: false }), "Applications are off.")}>Turn applications off</Button>
        </Card>
      ) : null}
    </div>
  );
}

/** Settings tab card that turns applications on (owners and admins, before anyone registers). */
export function ApplicationsEnableCard({ scope, canEnable, reason }: { scope: AdmissionScope; canEnable: boolean; reason: string | null }) {
  const { run, busy } = useAdmissionAction();
  return (
    <Card>
      <CardHeader title="Applications and shortlisting" description="Make registration an application: review it in stages, shortlist, and offer places. Works on any one-off event, free or paid, solo or teams." action={<HelpLink article="applications/overview" />} />
      {reason ? <Callout tone="info" className="mt-3">{reason}</Callout> : null}
      <Button className="mt-4" disabled={!canEnable} loading={busy === "on"} onClick={() => run("on", () => setApplicationsEnabled({ ...scope, enabled: true }), "Applications are on. Set them up in the Applications tab.")}>
        Take applications
      </Button>
    </Card>
  );
}
