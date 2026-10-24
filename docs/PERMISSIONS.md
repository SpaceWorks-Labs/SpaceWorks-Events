# Event permissions matrix

[Documentation index](README.md)

Who can see and use each part of the event and series dashboards. The server
is authoritative: every Server Action and route handler named below checks
access itself, and hiding a control is never authorisation (see
[Security](SECURITY.md#authorization-and-tenancy)). The dashboards derive what
they show from one helper, `eventCapabilities` / `seriesCapabilities` in
`lib/eventDashboard/capabilities.ts`, computed server-side in
`lib/eventDashboard/context.ts`, so a control is shown exactly when its action
would be allowed. `tests/unit/event-capabilities.test.ts` pins this table.

## Roles and grants

- **OWNER / ADMIN**: organisation owners and admins. They can do everything on
  this page for every event and series in their organisation.
- **MEMBER**: an organisation member. Members can open every event dashboard
  read-only; they act on an event only through a collaborator grant on it.
- **Collaborator (co-organiser)**: a user (usually not a member) holding an
  `EventCollaborator` grant on one standalone event or one series, with one or
  more exact `EventPermission` values. A grant never implies another, and a
  grant never reaches organisation-level operations. Server checks go through
  `canAccessEvent` (`lib/eventAccess.ts`): OWNER/ADMIN, or the exact grant on
  that event or series. A member who also holds a grant gets the grant.
- **Staff authenticator:** members and collaborators are staff, so none of
  this applies until they confirm an authenticator app (`lib/staffMfa.ts`,
  `/verify-mfa`); until then `getMembership` and `canAccessEvent` give no
  access.

| Grant | Covers |
| --- | --- |
| `EDIT_DETAILS` | Event page content: page settings (tagline, logo, accent, sections, about), highlights, speakers, sponsors, resources, FAQs, venue, and their uploads; ticket types, prices, add-ons and promo codes; creating, renaming, reordering, archiving and restoring custom check-in lists |
| `MANAGE_REGISTRATIONS` | The guest list: approve, decline, give a waitlist place, add a guest, edit and remove (with undo) registrations, the attendee CSV, registration numbers and revenue in the header, Overview and Analytics; payment operations on orders (refunds, offline payments, waivers, amendments) |
| `MANAGE_INVITATIONS` | The event's (or series') invite list: add and remove invited emails |
| `CHECK_IN` | The check-in desk and page: scan, search, preview, check in, undo, offline roster and sync, badge (ID card) printing; checking guests into and out of custom check-in lists |
| `PUBLISH_AND_SCHEDULE` | The programme: schedule tracks, sessions and live delays (standalone events), and series schedule items. Despite the name, setting an event Live stays with owners and admins |
| `JUDGE` | The hackathon judging workspace only ([Hackathon judging](HACKATHON.md)): reading and scoring the submissions the judge may see, with private reviews. Standalone events only. It satisfies no other check, and a non-member whose only grant is `JUDGE` is *judge-only*: the dashboard shows the judging workspace and nothing else (`isJudgeOnly`) |

## Event dashboard

`/dashboard/:orgSlug/event/:eventId`. "Admin" means organisation OWNER/ADMIN.
"—" means the control is hidden or replaced by a "no permission" note.

| Area and control | Server check | Admin | Member | `EDIT_DETAILS` | `MANAGE_REGISTRATIONS` | `MANAGE_INVITATIONS` | `CHECK_IN` | `PUBLISH_AND_SCHEDULE` | `JUDGE` | All grants |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Open the dashboard | `loadEventDashboard`: membership, or any grant on the event | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Judging only³ | Yes |
| Header: live numbers | page render; `canManageRegistrations` | Yes | — | — | Yes | — | — | — | — | Yes |
| Header: report PDF (after the event) | `GET /api/reports/event/:id`: admin | Yes | — | — | — | — | — | — | — | — |
| Header and Check-in tab: Open check-in | check-in page: `CHECK_IN` | Yes | — | — | — | — | Yes | — | — | Yes |
| Overview: readiness "Publish" | `publishEvent`: `canPublishEvents` (admin) | Yes | — | — | — | — | — | — | — | — |
| Overview: cover image item, At a glance "Edit" | `updateEvent`: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: programme item | schedule actions: `PUBLISH_AND_SCHEDULE` | Yes | — | — | — | — | — | Yes | — | Yes |
| Overview: registration-form item | registration-form actions: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: station PIN item | `app/actions/checkin-station.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: sign-ups, approvals ("Waiting for you") | RSVP actions: `MANAGE_REGISTRATIONS` | Yes | — | — | Yes | — | — | — | — | Yes |
| Overview: email item | broadcast actions: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: short link create/regenerate | `app/actions/shortLink.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: existing short link (copy only) | none (public link) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | — | Yes |
| Overview: "Embed" shortcut | none (Settings section is admin-only) | Yes | — | — | — | — | — | — | — | — |
| Overview: team card | collaborator actions: admin | Yes | — | — | — | — | — | — | — | — |
| Overview: "See how it went" (ended) | Analytics visibility | Yes | — | — | Yes | — | — | — | — | Yes |
| Guests · People: list, filters, ticket links | `loadAttendeesFirstPage` / `loadAttendeesPage` only for `canManageRegistrations` | Yes | — | — | Yes | — | — | — | — | Yes |
| Guests · People: approve, decline, give spot, add, edit, remove, undo remove | `app/actions/rsvp-lifecycle`, `app/actions/rsvp-admin.ts`: `canManageRegistrationsFor` | Yes | — | — | Yes | — | — | — | — | Yes |
| Guests · People: undo check-in | `app/actions/checkin.ts`: `CHECK_IN` | Yes | — | — | — | — | — | — | — | Yes |
| Guests · People: Export CSV / Export emails (current filters) | `GET /api/exports/events/:id/attendees`, `…/attendee-emails`: admin or `MANAGE_REGISTRATIONS` | Yes | — | — | Yes | — | — | — | — | Yes |
| Guests · Teams: Export CSV (current filters) | `GET /api/exports/events/:id/teams` via `resolveOrganiserEvent`: admin or `MANAGE_REGISTRATIONS` | Yes | — | — | Yes | — | — | — | — | Yes |
| Guests · Invites | `app/actions/invites.ts`: `MANAGE_INVITATIONS` | Yes | — | — | — | Yes | — | — | — | Yes |
| Event page · Details (title, dates, venue, capacity, privacy, discovery, registration window, cover, logo) | `updateEvent`, `uploadEventCoverImage`: admin | Yes | — | — | — | — | — | — | — | — |
| Event page · Page & programme: content editor | `app/actions/event-website.ts`: `EDIT_DETAILS` | Yes | — | Yes | — | — | — | — | — | Yes |
| Event page · Page & programme: "Open schedule" | schedule page and actions: `PUBLISH_AND_SCHEDULE` | Yes | — | — | — | — | — | Yes | — | Yes |
| Event page · Registration form | `app/actions/registration-form.ts`: `requireOrgRole(ADMIN)` | Yes | — | — | — | — | — | — | — | — |
| Emails: compose, test, send, history | `app/actions/broadcasts.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Check-in: desk, counts, ID cards | `app/actions/checkin.ts`: `CHECK_IN` | Yes | — | — | — | — | Yes | — | — | Yes |
| Check-in: check-in lists card, list switcher, scan/search into a list, undo, list guest view | `app/actions/checkin-lists.ts` over `lib/core/checkinLists.ts` (`checkInToListForUser`, `undoListCheckInForUser`, `lookupListAttendeesForUser`): `CHECK_IN` (`canCheckInToLists`) | Yes | — | — | — | — | Yes | — | — | Yes |
| Check-in: Manage lists (create, rename, reorder, archive, restore, requires entry check-in) | `app/actions/checkin-lists.ts` over `lib/core/checkinLists.ts` (`createCheckInListForUser`, `updateCheckInListForUser`, `reorderCheckInListsForUser`): `EDIT_DETAILS` (`canManageCheckInLists`) | Yes | — | Yes² | — | — | — | — | — | Yes |
| Check-in: door station PIN on/reveal/rotate/off | `app/actions/checkin-station.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Check-in: Export attendance | attendee CSV route | Yes | — | — | —¹ | — | — | — | — | Yes |
| Feedback: form, settings, certificate builder | `app/actions/feedback-form.ts`, `app/actions/certificate.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Feedback: responses (paged, `loadFeedbackResponsesPage`) and CSV | `GET /api/exports/events/:id/feedback`: admin | Yes | — | — | — | — | — | — | — | — |
| Analytics: numbers and revenue | page render; `canViewAnalytics` | Yes | — | — | Yes | — | — | — | — | Yes |
| Analytics: report PDF | report route: admin | Yes | — | — | — | — | — | — | — | — |
| Settings: tickets and pricing (ticket types, add-ons, promo codes) | `app/actions/ticket-types`: `EDIT_DETAILS` (`canEditTickets`) | Yes | — | Yes | — | — | — | — | — | Yes |
| Guests: order refunds, offline payments, waivers, amendments | `app/actions/payment-operations.ts`: `MANAGE_REGISTRATIONS` | Yes | — | — | Yes | — | — | — | — | Yes |
| Settings: co-organisers (invite, grants, remove, cancel invite) | `app/actions/event-collaborators.ts`: admin | Yes | — | — | — | — | — | — | — | — |
| Settings: event address (slug) | `updateEventSlug`: admin | Yes | — | — | — | — | — | — | — | — |
| Settings: clone | `cloneEvent`: admin | Yes | — | — | — | — | — | — | — | — |
| Settings: embed snippets | none (public URLs); admin-only by product rule | Yes | — | — | — | — | — | — | — | — |
| Settings: delete event | `deleteEvent`: admin | Yes | — | — | — | — | — | — | — | — |
| Schedule page (`…/schedule`) | page and `saveSession`/track/delay actions: `PUBLISH_AND_SCHEDULE` | Yes | 404 | 404 | 404 | 404 | 404 | Yes | 404 | Yes |
| Check-in page (`…/check-in`) | page and check-in actions: `CHECK_IN` | Yes | 404 | 404 | 404 | 404 | Yes | 404 | 404 | Yes |
| Judging tab: shown | page render; `canJudge` or `canManageJudging`, and the event uses judging (`eventUsesJudging`) | Yes | — | — | — | — | — | — | Yes | Yes |
| Judging: workspace (submissions to judge, scores, private review, Score next project) | `lib/judgingAccess.ts` `resolveJudgeContext`, `lib/core/judging.ts` (`nextSubmissionForJudge` uses the list's visibility query): admin or `JUDGE`; conflict-of-interest entries hidden | Yes | — | — | — | — | — | — | Yes | Yes |
| Judging: settings, window, rubric, assignments, judging status | `resolveJudgingOrganiser`: admin (`canManageJudging`) | Yes | — | — | — | — | — | — | — | — |
| Judging: disqualify, reinstate, awards, Adjust for harsh/generous judges, publish and unpublish results | `resolveJudgingOrganiser`: admin | Yes | — | — | — | — | — | — | — | — |
| Judging: Progress, review target, automatic assignment (preview and apply) | `resolveJudgingOrganiser` (`app/actions/judging-ops.ts`, `lib/core/judgingOps.ts`): admin | Yes | — | — | — | — | — | — | — | — |
| Judging: Submissions and Results Export CSV (current filters) | `GET /api/exports/events/:id/judging`: admin | Yes | — | — | — | — | — | — | — | — |
| Saved views on Guests · People and Teams: apply, save, rename, share, delete own; the URL filters | `app/actions/saved-views.ts` via `resolveSavedViewAccess` (`lib/core/savedViews.ts`): `canManageRegistrationsFor` (Teams: TEAM events) | Yes | — | — | Yes | — | — | — | — | Yes |
| Saved views on Judging · Submissions, Results, Progress | `resolveSavedViewAccess`: admin | Yes | — | — | — | — | — | — | — | — |
| Saved views: delete a view someone else shared | `deleteSavedView`: admin (creators always delete their own) | Yes | — | — | — | — | — | — | — | — |
| Settings: turn submissions on (before the Judging tab appears) | `updateJudgingSettings`: admin | Yes | — | — | — | — | — | — | — | — |

¹ The Check-in tab needs `CHECK_IN`, so this button needs both grants; a
`MANAGE_REGISTRATIONS`-only co-organiser downloads the same CSV from
Guests · People.

² An `EDIT_DETAILS`-only co-organiser sees the Check-in tab's lists card with
**Manage lists** and the counts, but not the desk or scanning, which need
`CHECK_IN`. Lists are set up like page content, ahead of the event, so they
follow `EDIT_DETAILS`; door staff with only `CHECK_IN` scan into the lists
they are given but cannot add, rename or archive them, which keeps one
volunteer from reshaping what every desk tracks. An event outside the
caller's organisation, or one they cannot open at all, answers
"Event not found."; a list of another event answers "List not found.".

³ A non-member whose only grant is `JUDGE` sees the event header and the
judging workspace and nothing else: no tabs, header numbers, page link, or
check-in. A member or a co-organiser with other grants who also holds `JUDGE`
gets the Judging tab next to what their other grants allow.

A saved view only selects filters inside a list. It is never an access
grant: the list's own check runs first, a shared view is listed only to
people who pass that check on that event, and someone else's private view
reads as missing. Only its creator renames or re-shares a view.

Managing judging (settings, rubric, assignments, disqualification, awards,
results, scores CSV) is deliberately owner/admin only. It is not covered by
`MANAGE_REGISTRATIONS` or any other grant: judging decides the competition's
outcome rather than who attends, so a co-organiser who runs the guest list
cannot rewrite the rubric or publish winners. See
[Hackathon judging](HACKATHON.md#judges).

## Series page

`/dashboard/:orgSlug/series/:seriesId`, following the same rules (`seriesCapabilities`) with
the series-level grant. Grants on a standalone event never reach a series, and a
series grant never reaches a standalone event.

| Control | Server check | Admin | Member | `MANAGE_REGISTRATIONS` | `MANAGE_INVITATIONS` | `PUBLISH_AND_SCHEDULE` | Other grants (`JUDGE` cannot be granted on a series) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Open the page | membership, or any grant on the series | Yes | Yes | Yes | Yes | Yes | Yes |
| Series details form, delete series | `updateEventSeriesMeta`, `deleteEventSeries`: admin | Yes | — | — | — | — | — |
| Invites | `addSeriesInvite`, `removeSeriesInvite`: `MANAGE_INVITATIONS` on the series | Yes | — | — | Yes | — | — |
| Schedule items | `app/actions/schedule.ts`: `PUBLISH_AND_SCHEDULE` on the series | Yes | — | — | — | Yes | — |
| Ticket types and passes | `app/actions/ticket-types`: `EDIT_DETAILS` on the series | Yes | — | — | — | — | `EDIT_DETAILS` |
| Attendees (first occurrence): approve, decline, give spot, edit, remove | RSVP actions: `MANAGE_REGISTRATIONS` on the series | Yes | — | Yes | — | — | — |
| Occurrence report PDFs | `GET /api/reports/instance/:id`: admin | Yes | — | — | — | — | — |

## Organisation-level screens

Creating events and series, organisation settings, members and invitations,
API access (`app/actions/api-clients.ts`, owner only), outgoing webhooks, and
deleting the organisation are owner/admin (or owner) operations that no
collaborator grant reaches.

| Control | Server check | Owner | Admin | Member | Collaborator (any grants) |
| --- | --- | --- | --- | --- | --- |
| Settings → Webhooks section and pages | `requireOrgRole(ADMIN)`; others are redirected to the organisation | Yes | Yes | — | — |
| Add, edit, delete endpoint; rotate secret; enable/disable | `app/actions/webhooks.ts`: `canManageWebhooks` (`lib/permissions.ts`), `webhookManage` rate limit, audited | Yes | Yes | — | — |
| Send test, Redeliver, delivery log | `app/actions/webhooks.ts`: `canManageWebhooks`, `webhookTest` rate limit | Yes | Yes | — | — |

Every webhook query includes the organisation, so an endpoint or delivery id
from another organisation is "not found" (a 404 page, or the action error
"Webhook endpoint not found."). See [Organisation webhooks](WEBHOOKS.md). Collaborators who are not members see only the list of events they
co-organise on `/dashboard/:orgSlug`.

## Known gaps

- `EDIT_DETAILS` does not cover the Details form. `updateEvent` writes
  publication status, privacy, discovery listing, capacity and the
  registration window in one action, which are owner/admin decisions, so a
  co-organiser edits page content but not the title or dates. Splitting the
  form would let the grant cover the descriptive fields.
- The registration form questions are owner/admin only; no grant covers them.
- Custom check-in lists are web-only for now: offline check-in, the venue
  station and series occurrences do not reach them. The cores in
  `lib/core/checkinLists.ts` already take a `source` (`mobile-scan`,
  `mobile-manual`) for a future mobile client.
