"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/field";
import { SwitchRow } from "@/components/ui/choice";
import { saveMentorProfileAsOrganiser } from "@/app/actions/mentor-desk";
import { saveOwnMentorProfile } from "@/app/actions/mentor-console";
import { MENTOR_AFFILIATION_MAX_LENGTH, MENTOR_AVAILABILITY_MAX, MENTOR_BIO_MAX_LENGTH, MENTOR_MAX_TEAMS_MAX } from "@/lib/mentorDesk/rules";
import { type DeskScope, ErrorLine, splitTags, useDeskSave } from "./shared";

export type ProfileValue = {
  version: number; skills: string[]; bio: string; affiliation: string; maxActiveTeams: number; showOnPage: boolean;
  availability: Array<{ start: string; end: string }>;
};

/**
 * A mentor profile: skills (up to 8), bio, private affiliation, capacity,
 * the event-page listing and availability windows in the event's timezone.
 * Outside every window the mentor is off shift. Mentors edit their own;
 * owners and admins edit anyone's.
 */
export function ProfileForm({ scope, mentorUserId, profile, timeZone, bounds, as }: {
  scope: DeskScope; mentorUserId: string; profile: ProfileValue; timeZone: string;
  bounds: { start: string; end: string }; as: "organiser" | "mentor";
}) {
  const { pending, error, save } = useDeskSave();
  const [skills, setSkills] = useState(profile.skills.join(", "));
  const [bio, setBio] = useState(profile.bio);
  const [affiliation, setAffiliation] = useState(profile.affiliation);
  const [maxActiveTeams, setMax] = useState(String(profile.maxActiveTeams));
  const [showOnPage, setShowOnPage] = useState(profile.showOnPage);
  const [windows, setWindows] = useState(profile.availability);
  const action = as === "organiser" ? saveMentorProfileAsOrganiser : saveOwnMentorProfile;
  const setWindow = (index: number, key: "start" | "end", value: string) => setWindows((list) => list.map((w, i) => (i === index ? { ...w, [key]: value } : w)));
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => action({ ...scope, mentorUserId, expectedVersion: profile.version, skills: splitTags(skills), bio, affiliation, maxActiveTeams: Number(maxActiveTeams), showOnPage, availability: windows }), "Profile saved.");
      }}
    >
      <Field label="Skills" helperText="Up to 8, separated by commas. Categories and skill-match assignment use them.">
        <Input value={skills} onChange={(e) => setSkills(e.target.value)} />
      </Field>
      <Field label="Bio" optional>
        <Textarea rows={3} value={bio} maxLength={MENTOR_BIO_MAX_LENGTH} onChange={(e) => setBio(e.target.value)} />
      </Field>
      <Field label="Affiliation" optional helperText="Private to organisers and you. Used for conflicts of interest.">
        <Input value={affiliation} maxLength={MENTOR_AFFILIATION_MAX_LENGTH} onChange={(e) => setAffiliation(e.target.value)} />
      </Field>
      <Field label="Most teams at once">
        <Input type="number" min={1} max={MENTOR_MAX_TEAMS_MAX} value={maxActiveTeams} onChange={(e) => setMax(e.target.value)} className="max-w-32" />
      </Field>
      <SwitchRow label="Show on the event page" description="Name, bio and skills only; never the affiliation or email." checked={showOnPage} onCheckedChange={setShowOnPage} />
      <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
        <legend className="px-1 text-label text-ink">Availability ({timeZone})</legend>
        <p className="text-caption text-ink-muted">Within the event. With no windows you are off duty: the queue and visits refuse you.</p>
        {windows.map((w, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <Input type="datetime-local" aria-label="From" min={bounds.start} max={bounds.end} value={w.start} onChange={(e) => setWindow(index, "start", e.target.value)} className="max-w-56" />
            <span className="text-caption text-ink-muted">to</span>
            <Input type="datetime-local" aria-label="Until" min={bounds.start} max={bounds.end} value={w.end} onChange={(e) => setWindow(index, "end", e.target.value)} className="max-w-56" />
            <IconButton label="Remove window" variant="danger" onClick={() => setWindows((list) => list.filter((_, i) => i !== index))}><Trash2 aria-hidden className="size-4" /></IconButton>
          </div>
        ))}
        {windows.length < MENTOR_AVAILABILITY_MAX ? (
          <Button type="button" size="sm" variant="ghost" startIcon={<Plus aria-hidden className="size-4" />} className="self-start" onClick={() => setWindows((list) => [...list, { start: bounds.start, end: bounds.end }])}>Add window</Button>
        ) : null}
      </fieldset>
      <ErrorLine error={error} />
      <Button type="submit" variant="primary" loading={pending} className="self-start">Save profile</Button>
    </form>
  );
}
