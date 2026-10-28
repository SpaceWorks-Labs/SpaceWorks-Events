"use client";

import { useState } from "react";
import { manageContributorCertificate, saveContributorCertificateDesign } from "@/app/actions/volunteer-shifts";
import { CertificateBuilder } from "@/components/feedback/CertificateBuilder";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader, Chip } from "@/components/ui/display";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { crewKindLabel } from "@/lib/crewKind";
import { formatDuration } from "@/lib/volunteer/math";
import type { CertificateTemplate } from "@/lib/certificateTemplate";
import type { DashboardVolunteerShifts } from "@/lib/eventDashboard/volunteerShifts";

type Run = (key: string, action: () => Promise<{ ok: boolean; error?: string }>, success?: string) => void;

/**
 * Contributors and certificates (docs/VOLUNTEERS.md): each crew member's
 * verified hours and expense claims side by side (hours are never money),
 * and their contributor certificate. Owners and admins issue certificates,
 * never their own; volunteers need verified hours.
 */
export function ContributorsCard({ organisationSlug, eventId, data, busyKey, run }: {
  organisationSlug: string; eventId: string; data: DashboardVolunteerShifts; busyKey: string | null; run: Run;
}) {
  const [designing, setDesigning] = useState(false);
  const [template, setTemplate] = useState<CertificateTemplate | null>(data.template);
  const [designBusy, setDesignBusy] = useState(false);
  const scope = { organisationSlug, eventId };
  const people = data.contributors.filter((person) => person.verifiedMinutes > 0 || person.pendingHours > 0 || person.certificate || person.claims.total > 0 || person.eligible);

  return (
    <Card as="section" aria-labelledby="contributors-title" className="flex flex-col gap-3">
      <CardHeader
        title={<span id="contributors-title">Contributors and certificates</span>}
        titleAs="h3"
        description="Verified hours and expense claims per person. Hours are never paid; claims are handled in Finance."
        action={data.isAdmin ? <Button size="sm" variant="secondary" onClick={() => setDesigning(true)}>Design certificate</Button> : undefined}
      />
      {!data.isAdmin ? <Callout tone="info">Only organisation owners and admins can issue certificates.</Callout> : null}
      {people.length === 0 ? (
        <p className="text-body-ui text-ink-muted">Verified hours and certificates appear here.</p>
      ) : (
        <ul aria-label="Contributors" className="flex flex-col divide-y divide-line">
          {people.map((person) => (
            <li key={person.crewMemberId} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
              <div className="flex min-w-0 flex-[1_1_200px] flex-col">
                <span className="truncate font-semibold text-ink">{person.name}</span>
                <span className="text-caption text-ink-muted">
                  {crewKindLabel(person.kind)}{person.role ? ` · ${person.role}` : ""} · {formatDuration(person.verifiedMinutes)} verified
                  {person.pendingHours ? ` · ${person.pendingHours} to verify` : ""}
                  {person.claims.total ? ` · ${person.claims.total} expense ${person.claims.total === 1 ? "claim" : "claims"}${person.claims.open ? ` (${person.claims.open} open)` : ""}` : ""}
                </span>
              </div>
              {person.certificate ? <Chip size="sm" tone="success">Certificate issued</Chip> : null}
              {data.isAdmin && !person.isViewer ? (
                <div className="ml-auto">
                  {person.certificate ? (
                    <Button size="sm" variant="dangerQuiet" disabled={busyKey != null} onClick={() => run(person.crewMemberId, () => manageContributorCertificate({ ...scope, crewMemberId: person.crewMemberId, action: "revoke" }), "Certificate revoked")}>Revoke</Button>
                  ) : person.eligible ? (
                    <Button size="sm" variant="secondary" loading={busyKey === person.crewMemberId} disabled={busyKey != null} onClick={() => run(person.crewMemberId, () => manageContributorCertificate({ ...scope, crewMemberId: person.crewMemberId, action: "issue" }), `Certificate issued to ${person.name}`)}>Issue certificate</Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <Dialog open={designing} onOpenChange={(open) => !open && !designBusy && setDesigning(false)}>
        <DialogContent size="xl">
          <DialogHeader title="Contributor certificate" description="Use Contributor role and Hours contributed to print each person's role and verified hours. Certificates already issued keep their design." />
          <DialogBody>
            <CertificateBuilder contributor organisationSlug={organisationSlug} eventId={eventId} value={template} onChange={setTemplate} disabled={designBusy} onBusyChange={setDesignBusy} eventTitle={data.eventTitle} eventDateLabel={data.eventDateLabel} organisationName={data.organisationName} />
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDesigning(false)} disabled={designBusy}>Close</Button>
            <Button variant="primary" disabled={designBusy} onClick={() => { setDesigning(false); run("design", () => saveContributorCertificateDesign({ ...scope, template }), "Certificate design saved"); }}>Save design</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
