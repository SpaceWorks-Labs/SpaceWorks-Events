"use client";

import { useState } from "react";
import { extendApplicationOffer, respondForApplication } from "@/app/actions/admission";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { useAdmissionAction, type AdmissionScope, type ApplicationRow } from "./shared";

const DAY = 86_400_000;

/**
 * Offer controls for one application: give more time to answer, or answer
 * for the applicant (they asked by email, say). Accepting a paid place for
 * them sends the payment link; it is confirmed only once paid.
 */
export function OfferControls({ scope, application, paid }: { scope: AdmissionScope; application: ApplicationRow; paid: boolean }) {
  const { run, busy } = useAdmissionAction();
  const [days, setDays] = useState("3");
  if (application.status === "OFFERED") {
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-label">Offer</h4>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Give more days">
            <Input type="number" min={1} max={30} value={days} onChange={(event) => setDays(event.target.value)} />
          </Field>
          <Button
            size="sm"
            loading={busy === "extend"}
            onClick={() => {
              const from = application.respondBy ? Math.max(Date.parse(application.respondBy), Date.now()) : Date.now();
              run("extend", () => extendApplicationOffer({ ...scope, applicationId: application.id, respondBy: new Date(from + Number(days) * DAY).toISOString() }), "Offer extended. The applicant was emailed.");
            }}
          >
            Extend
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" loading={busy === "accept"} onClick={() => run("accept", () => respondForApplication({ ...scope, applicationId: application.id, response: "accept" }), paid ? "Accepted for them: the payment link is on its way." : "Accepted for them: their place is confirmed.")}>
            {paid ? "Accept for them (send payment link)" : "Accept for them"}
          </Button>
          <Button size="sm" variant="secondary" loading={busy === "decline"} onClick={() => run("decline", () => respondForApplication({ ...scope, applicationId: application.id, response: "decline" }), "Declined for them.")}>Decline for them</Button>
        </div>
      </div>
    );
  }
  if (application.status === "IN_REVIEW" || application.status === "WAITLISTED") {
    return (
      <div>
        <Button size="sm" variant="quiet" loading={busy === "withdraw"} onClick={() => run("withdraw", () => respondForApplication({ ...scope, applicationId: application.id, response: "withdraw" }), "Withdrawn at their request.")}>Withdraw at their request</Button>
      </div>
    );
  }
  return null;
}
