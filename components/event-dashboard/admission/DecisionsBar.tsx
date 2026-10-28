"use client";

import { useState } from "react";
import { cancelApplicationDecisions, releaseApplicationDecisions } from "@/app/actions/admission";
import { ConfirmationDialog } from "@/components/feedback/ConfirmationDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/display";
import { useAdmissionAction, type AdmissionData, type AdmissionScope } from "./shared";

/**
 * The draft batch: how many decisions are waiting, how many offers they
 * make against those left, and Release (all at once, or none) or Cancel.
 */
export function DecisionsBar({ scope, data }: { scope: AdmissionScope; data: AdmissionData }) {
  const { run, busy } = useAdmissionAction();
  const [confirming, setConfirming] = useState(false);
  const drafted = data.applications.filter((app) => app.draft);
  if (drafted.length === 0) return null;
  const offers = drafted.filter((app) => app.draft?.outcome === "ACCEPT").length;
  const left = data.settings.ceiling == null ? null : Math.max(0, data.settings.ceiling - data.settings.holding);
  const stale = drafted.filter((app) => app.draft?.stale).length;
  const short = drafted.filter((app) => app.status === "IN_REVIEW" && app.counted < app.target && !app.draft?.overrideReason).length;
  const summary = (value: unknown) => {
    const counts = value as Record<string, number>;
    return `Released: ${counts.ACCEPT ?? 0} offered, ${counts.ADVANCE ?? 0} moved on, ${counts.WAITLIST ?? 0} waitlisted, ${counts.REJECT ?? 0} declined.`;
  };
  return (
    <Callout
      tone={stale || short || (left != null && offers > left) ? "warning" : "info"}
      title={`${drafted.length} drafted ${drafted.length === 1 ? "decision" : "decisions"}`}
      action={
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={busy === "release"} onClick={() => setConfirming(true)}>Release</Button>
          <Button variant="secondary" loading={busy === "cancel"} onClick={() => run("cancel", () => cancelApplicationDecisions(scope), "Draft cancelled. Nothing was sent.")}>Cancel draft</Button>
        </div>
      }
    >
      {offers ? `${offers} ${offers === 1 ? "offer" : "offers"}${left == null ? "" : ` of ${left} left`}. ` : ""}
      {short ? `${short} short of reviews without an override reason. ` : ""}
      {stale ? `${stale} changed since drafting: draft ${stale === 1 ? "it" : "them"} again.` : ""}
      <ConfirmationDialog
        open={confirming}
        title="Release these decisions?"
        message="Every drafted decision takes effect together and applicants are emailed. If any can't be released, none is."
        confirmLabel="Release"
        destructive={false}
        loading={busy === "release"}
        onCancel={() => setConfirming(false)}
        onConfirm={() => run("release", () => releaseApplicationDecisions(scope), summary, () => setConfirming(false))}
      />
    </Callout>
  );
}
