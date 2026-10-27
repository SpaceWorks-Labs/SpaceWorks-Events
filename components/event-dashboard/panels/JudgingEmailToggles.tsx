"use client";

import { SwitchRow } from "@/components/ui/choice";
import { Callout } from "@/components/ui/display";

/**
 * Judging → Setup's "Hackathon emails": the two opt-in emails
 * (lib/hackathonEmails.ts), both off by default and saved with the judging
 * settings. Registration, team, submission-link and payment emails always go
 * out and have no switch here. The server enforces these when it queues the
 * email; only owners and admins reach this card.
 */
export function JudgingEmailToggles({
  emailOnResults,
  onEmailOnResults,
  emailReceipts,
  onEmailReceipts,
  pendingAnnouncement,
}: {
  emailOnResults: boolean;
  onEmailOnResults: (on: boolean) => void;
  emailReceipts: boolean;
  onEmailReceipts: (on: boolean) => void;
  /** Results are published and nobody has been emailed about this publication yet. */
  pendingAnnouncement: boolean;
}) {
  return (
    <fieldset className="flex flex-col gap-3.5 rounded-lg border border-line p-3.5">
      <legend className="px-1 text-label text-ink">Hackathon emails</legend>
      <p className="text-caption text-ink-muted">
        Both are off unless you turn them on. Registration, team, submission-link and payment emails always go out.
      </p>
      <SwitchRow
        label="Email entrants when results are published"
        description="Every confirmed entrant gets one email saying the results are out. Off: the results page goes live without emailing anyone."
        checked={emailOnResults}
        onCheckedChange={onEmailOnResults}
      />
      {emailOnResults && pendingAnnouncement ? (
        <Callout tone="info">Results are already published. After saving, send the email from the Results tab with “Send results email now”.</Callout>
      ) : null}
      <SwitchRow
        label="Email a receipt when a project is submitted"
        description="The person who submits gets a confirmation that the project was received, including when it is submitted once its entry fee is paid."
        checked={emailReceipts}
        onCheckedChange={onEmailReceipts}
      />
    </fieldset>
  );
}
