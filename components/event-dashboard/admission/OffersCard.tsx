"use client";

import { Card, CardHeader, EmptyState } from "@/components/ui/display";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { formatWhen, type AdmissionData } from "./shared";

/**
 * Applications → Offers and waitlist: open offers with their deadlines, and
 * the waitlist in the order it is offered places (first in, first offered),
 * with why an application was passed over. Answer or extend an offer from
 * the application itself (Review and decide).
 */
export function OffersCard({ data }: { data: AdmissionData }) {
  const tz = data.settings.timezone;
  const offered = data.applications.filter((app) => app.status === "OFFERED").sort((a, b) => (a.respondBy ?? "").localeCompare(b.respondBy ?? ""));
  const waiting = data.applications.filter((app) => app.status === "WAITLISTED").sort((a, b) => (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "") || a.id.localeCompare(b.id));
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title="Open offers" description={`${data.settings.holding} offered or accepted${data.settings.ceiling == null ? "" : ` of ${data.settings.ceiling}`}. Unanswered offers expire and pass to the waitlist.`} />
        {offered.length === 0 ? <EmptyState title="No open offers" /> : (
          <Table label="Open offers">
            <THead><TR><TH>Applicant</TH><TH>Answer by</TH></TR></THead>
            <TBody>{offered.map((app) => <TR key={app.id}><TD>{app.name}</TD><TD>{formatWhen(app.respondBy, tz)}</TD></TR>)}</TBody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader title="Waitlist" description="Offered free places in this order. An application that can't take a place now is passed over and keeps its place in the queue." />
        {waiting.length === 0 ? <EmptyState title="Nobody on the waitlist" /> : (
          <Table label="Waitlist">
            <THead><TR><TH>#</TH><TH>Applicant</TH><TH>Joined</TH><TH>Note</TH></TR></THead>
            <TBody>{waiting.map((app, index) => <TR key={app.id}><TD>{index + 1}</TD><TD>{app.name}</TD><TD>{formatWhen(app.queuedAt, tz)}</TD><TD>{app.skipReason ?? ""}</TD></TR>)}</TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
