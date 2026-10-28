"use client";

import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout, Chip } from "@/components/ui/display";
import { Accordion, AccordionItem } from "@/components/ui/tabs";
import { useToast } from "@/components/feedback/ToastProvider";

type Endpoint = {
  title: string;
  scope: string;
  description: string;
  request: string;
  response: string;
};

type ScopeReference = {
  scope: string;
  capability: string;
  includes: string;
  excludes: string;
};

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function CodeBlock(props: { label: string; value: string }) {
  const { showToast } = useToast();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-label text-ink">{props.label}</p>
        <Button
          size="sm"
          variant="quiet"
          startIcon={<Copy />}
          onClick={() => void copyToClipboard(props.value).then(() => showToast(`${props.label} copied`, "success"))}
        >
          Copy
        </Button>
      </div>
      <pre className="m-0 overflow-x-auto whitespace-pre rounded-md bg-inverse px-4 py-3 font-mono text-xs leading-relaxed text-on-inverse">
        {props.value}
      </pre>
    </div>
  );
}

function EndpointReference({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body-ui text-ink-secondary">{endpoint.description}</p>
      <CodeBlock label="Request" value={endpoint.request} />
      <CodeBlock label="Success response" value={endpoint.response} />
    </div>
  );
}

export function ApiDeveloperReference({ apiBaseUrl }: { apiBaseUrl: string }) {
  const token = "<credential-shown-once>";
  const eventId = "<event-id>";
  const endpoints: Endpoint[] = [
    {
      title: "List events",
      scope: "events:read",
      description: "Lists this organisation’s standalone events. Use the returned cursor unchanged to fetch the next page.",
      request: `curl --request GET --url "${apiBaseUrl}/events?limit=50" --header "Authorization: Bearer ${token}"`,
      response: `{
  "data": [
    {
      "id": "event-id",
      "title": "Product launch",
      "slug": "product-launch",
      "description": "An introduction to the new product.",
      "tags": ["product", "launch"],
      "coverImageUrl": null,
      "startDateTime": "2030-01-01T10:00:00.000Z",
      "endDateTime": "2030-01-01T11:00:00.000Z",
      "timezone": "UTC",
      "location": "Online",
      "mapLinkUrl": null,
      "isOnline": true,
      "capacity": 100,
      "status": "PUBLISHED",
      "privacyType": "PUBLIC",
      "createdAt": "2029-12-01T09:00:00.000Z"
    }
  ],
  "pagination": { "nextCursor": "opaque-cursor-or-null" }
}`,
    },
    {
      title: "Read an event",
      scope: "events:read",
      description: "Returns one event belonging to this organisation. Keep the event ID from the event-list response.",
      request: `curl --request GET --url "${apiBaseUrl}/events/${eventId}" --header "Authorization: Bearer ${token}"`,
      response: `{
  "data": {
    "id": "event-id",
    "title": "Product launch",
    "slug": "product-launch",
    "description": "An introduction to the new product.",
    "tags": ["product", "launch"],
    "coverImageUrl": null,
    "startDateTime": "2030-01-01T10:00:00.000Z",
    "endDateTime": "2030-01-01T11:00:00.000Z",
    "timezone": "UTC",
    "location": "Online",
    "mapLinkUrl": null,
    "isOnline": true,
    "capacity": 100,
    "status": "PUBLISHED",
    "privacyType": "PUBLIC",
    "createdAt": "2029-12-01T09:00:00.000Z"
  }
}`,
    },
    {
      title: "List confirmed participants",
      scope: "participants:read",
      description: "Lists minimal, confirmed-participant records only. Attendance filters and check-in timestamps require the attendance scope.",
      request: `curl --request GET --url "${apiBaseUrl}/events/${eventId}/participants?attendance=checked_in&include=attendance" --header "Authorization: Bearer ${token}"`,
      response: `{
  "data": [
    {
      "id": "rsvp-id",
      "displayName": "Participant name",
      "registeredAt": "2030-01-01T10:00:00.000Z",
      "checkedInAt": "2030-01-01T10:15:00.000Z"
    }
  ],
  "pagination": { "nextCursor": "opaque-cursor-or-null" }
}`,
    },
  ];
  endpoints.push({
    title: "List orders",
    scope: "orders:read",
    description: "Lists an event's orders with their totals, newest first. Amounts are decimal strings in the order's currency.",
    request: `curl --request GET --url "${apiBaseUrl}/events/${eventId}/orders?limit=50" --header "Authorization: Bearer ${token}"`,
    response: `{
  "data": [
    {
      "id": "order-id",
      "reference": "SW-7F3K2",
      "status": "CONFIRMED",
      "currency": "INR",
      "total": "1500.00",
      "paid": "1500.00",
      "refunded": "0.00",
      "tickets": 2,
      "testMode": false,
      "placedAt": "2030-01-01T10:00:00.000Z"
    }
  ],
  "pagination": { "nextCursor": "opaque-cursor-or-null" }
}`,
  });
  endpoints.push({
    title: "Application counts",
    scope: "applications:read",
    description: "Counts an event's applications by status and by stage, with the offers out. Numbers only.",
    request: `curl --request GET --url "${apiBaseUrl}/events/${eventId}/applications" --header "Authorization: Bearer ${token}"`,
    response: `{
  "data": {
    "eventId": "event-id",
    "enabled": true,
    "total": 120,
    "byStatus": { "IN_REVIEW": 80, "OFFERED": 10, "WAITLISTED": 5, "ACCEPTED": 20, "REJECTED": 3, "DECLINED": 1, "EXPIRED": 1, "WITHDRAWN": 0 },
    "stages": [{ "position": 1, "name": "Review", "status": "OPEN", "reached": 120, "inReview": 60 }],
    "offers": { "out": 30, "limit": 40 }
  }
}`,
  });
  const scopes: ScopeReference[] = [
    {
      scope: "events:read",
      capability: "Read standalone event metadata owned by this organisation.",
      includes: "List events and read a specific event, including draft, published, and hidden events.",
      excludes: "Participants, RSVP workflow data, contact information, registration answers, and all write operations.",
    },
    {
      scope: "participants:read",
      capability: "Read the minimal confirmed-participant roster for an event owned by this organisation.",
      includes: "RSVP ID, display name, and registration timestamp for confirmed attendees only.",
      excludes: "Email addresses, user IDs, answers, invitations, feedback linkage, attendance state/timestamps, and ticket, check-in, or certificate tokens.",
    },
    {
      scope: "participants:attendance:read",
      capability: "Filter by attendance state and opt in to check-in timestamps for the minimal participant roster.",
      includes: "checked_in/not_checked_in filtering and the nullable checkedInAt timestamp when include=attendance is sent. It also requires participants:read.",
      excludes: "Email addresses, user IDs, answers, invitations, check-in tokens, and all write operations.",
    },
    {
      scope: "orders:read",
      capability: "Read the orders placed for an event owned by this organisation.",
      includes: "Order ID, reference, status, currency, total, amount paid and refunded, ticket count, test flag and when it was placed.",
      excludes: "Buyer names and email addresses, order links, receipts, card details, payment provider IDs, and all write operations.",
    },
    {
      scope: "applications:read",
      capability: "Count the applications of an event owned by this organisation.",
      includes: "Totals by status and by stage, and the offers out against the offer limit.",
      excludes: "Applicant names and contact details, answers, reviews, scores, reviewers, and all write operations.",
    },
  ];

  return (
    <section aria-labelledby="api-reference-title" className="flex flex-col gap-4">
      <div>
        <h2 id="api-reference-title" className="text-title text-ink">Developer reference</h2>
        <p className="mt-1 text-body-ui text-ink-muted">Use this tenant-bound REST API from your backend service or automation.</p>
      </div>
      <Callout tone="warning">Credentials are shown only when created. Keep them in a secret manager; never expose them in browser code, URLs, source control, or logs.</Callout>
      <div className="rounded-lg border border-line bg-panel px-5">
        <Accordion type="multiple" defaultValue={["getting-started"]}>
          <AccordionItem
            value="getting-started"
            title={
              <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <span>Getting started</span>
                <span className="break-all tabular-nums text-xs font-normal text-ink-muted">{apiBaseUrl}</span>
              </span>
            }
          >
            <div className="flex flex-col gap-3">
              <CodeBlock label="API base URL" value={apiBaseUrl} />
              <div className="flex flex-wrap gap-1.5">
                <Chip size="sm">Bearer authentication</Chip>
                <Chip size="sm">JSON responses</Chip>
                <Chip size="sm">No-store caching</Chip>
                <Chip size="sm">Maximum page size: 100</Chip>
              </div>
            </div>
          </AccordionItem>
          <AccordionItem value="scopes" title={`Scopes (${scopes.length})`}>
            <ul className="flex flex-col divide-y divide-line">
              {scopes.map((scope) => (
                <li key={scope.scope} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
                  <Chip size="sm" tone="outline" className="self-start tabular-nums">{scope.scope}</Chip>
                  <p className="text-body-ui text-ink">{scope.capability}</p>
                  <p className="text-body-ui text-ink-secondary"><strong className="text-ink">Includes:</strong> {scope.includes}</p>
                  <p className="text-body-ui text-ink-secondary"><strong className="text-ink">Does not include:</strong> {scope.excludes}</p>
                </li>
              ))}
            </ul>
          </AccordionItem>
          {endpoints.map((endpoint) => (
            <AccordionItem
              key={endpoint.title}
              value={endpoint.title}
              title={
                <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <span>{endpoint.title}</span>
                  <Chip size="sm" tone="outline" className="self-start tabular-nums sm:self-center">{endpoint.scope}</Chip>
                </span>
              }
            >
              <EndpointReference endpoint={endpoint} />
            </AccordionItem>
          ))}
          <AccordionItem value="pagination" title="Pagination and errors" className="border-b-0">
            <div className="flex flex-col gap-3">
              <p className="text-body-ui text-ink-secondary">Collection endpoints default to 50 items and accept `limit` from 1 through 100. When `pagination.nextCursor` is non-null, pass it back as the `cursor` query parameter. Do not inspect or construct cursors.</p>
              <CodeBlock label="Error response" value={`{
  "error": {
    "code": "INSUFFICIENT_SCOPE",
    "message": "The credential does not have permission for this resource."
  }
}`} />
              <p className="text-body-ui text-ink-secondary">Error codes: `INVALID_REQUEST`, `INVALID_CREDENTIAL`, `INSUFFICIENT_SCOPE`, `RESOURCE_NOT_FOUND`, `RATE_LIMITED`, and `INTERNAL_ERROR`. A rate-limited response includes `Retry-After`.</p>
            </div>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  );
}
