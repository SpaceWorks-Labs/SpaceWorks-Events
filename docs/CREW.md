# Event crew

[Documentation index](README.md)

The crew is an event's organising team: volunteers, hosts, stage and
logistics people. Organisers keep the crew list in **Guests → Crew**, every
crew member gets a free ticket for check-in, and the event page can show the
crew as profile cards. This page is the design contract; [Features](FEATURES.md)
summarises the shipped behaviour. Ported from Yuyu's event crew and extended
for Space Works payments, finance, ID badges, designed tickets, chat and
webhooks.

## Scope

- One-off events only (`EventCrewMember.eventId`); recurring series and
  occurrences have no crew.
- A crew member is a person, not an account: they need no sign-in. Being on
  the crew grants **no** dashboard access and no staff authenticator check.
- Crew are never part of a team, never hackathon entrants, never buy a
  ticket, and never take part in the guest registration flows (see
  [What the other flows refuse](#what-the-other-flows-refuse)).
- `EventCrewMember` is a person record with a ticket. It has a `kind`
  (`ORGANISER`, `VOLUNTEER`, `MENTOR`, `JUDGE`; default `VOLUNTEER`) for
  display, badges and the crew list filter only, and an optional account
  link (`userId`). Neither grants anything; the ticket rules below stay the
  same. Volunteer shifts, hours and contributor certificates build on the
  crew: see [Volunteer shifts](VOLUNTEERS.md).

## Data model

| Model / field | Meaning |
| --- | --- |
| `EventCrewMember` | One crew member: `name`, `email` (trimmed, lowercase; unique per event), `foodPreference`, `role`, `bio`, `photoUrl`, `linkedinUrl`, `showOnPage`, `joinedViaLink`, `sortOrder`, `kind` (display only), `userId` (optional account link, set null when the account is deleted; see [Volunteer shifts](VOLUNTEERS.md#data-model) for when it is set). Belongs to the event and to exactly one RSVP (`rsvpId`, unique), and cascades from both. |
| `RSVP.isCrew` | Marks that RSVP as the member's crew ticket. |
| `EventCrewJoinLink` | At most one per event: the crew sign-up `token`, the `kind` link sign-ups get (default `VOLUNTEER`), and its `createdAt`. Cascades with the event. |
| `EventPageSectionType.CREW` | The public Crew section of the event page. |
| `ExpenseClaimKind.CREW`, `Event.crewClaimsEnabled` | Crew expense claims (off by default). |

The `RSVP_crew_shape` CHECK constraint (migration `20261110000000_event_crew`,
added `NOT VALID` then validated) guarantees that a crew ticket belongs to an
event, has no team, no order and no ticket type, and is `CONFIRMED`. The
schema verifier (`npm run db:verify`) checks it, both tables, the column and
the cascading `EventCrewMember_rsvpId_fkey`.

Field limits: name 120, email 254, food preference 80, role 120, bio 600,
LinkedIn URL 500 (`http:` or `https:` only). The photo must be an application
upload in the organisation's `event-crew` category (validated, re-encoded to
WebP, metadata stripped). Names and bios are plain text. At most 500 crew
members per event.

## Capacity rule

Crew count in the event's headcount (they are confirmed and "going"), but
**never against `Event.capacity`** and never against paid seat holds. Every
capacity count spreads `takesCapacity` (`{ isCrew: false }`) into its query:
`seatTakingWhere` (`lib/payments/holds.ts`, which every paid and free seat
count uses, including `reserveRsvp`, `lib/rsvpCapacity.ts`, orders, tickets
and waitlist offers), `countConfirmedUnits` and `countConfirmedForCapacity`
(`lib/teamUnits.ts`). An event with capacity 1 and two crew still sells or
confirms one attendee before the waitlist starts.

Dashboards name crew beside the places: the Overview header (`2 / 50 · + 3
crew`), Analytics (places left exclude crew), the dashboard home list
(`loadRsvpCounts` subtracts crew from units) and the super-admin upcoming
list. The public event page counts crew in *N going* (individual events, when
counts are shown) but never in *spots left* or *sold out*.

## Tickets, email and check-in

- Adding a crew member creates a free `CONFIRMED` RSVP with `isCrew` (no
  order, no ticket type) and queues the `crew-ticket` outbox email
  (`lib/outbox/crew.ts`, transactional, deleted after delivery because it
  carries the ticket link). The worker re-reads the ticket and sends
  *You're on the crew for …* with the role, time, venue, calendar invite and
  the designed ticket PDF; a removed member or a cancelled event gets nothing.
- When the email already has a **free solo** registration, an organiser
  adding them converts it into the crew ticket: it keeps its token, QR code
  and check-in, becomes `CONFIRMED`, takes the crew name (guest tickets), and
  a confirmed place it held is offered to the waitlist after the commit
  (`fillFromWaitlist`). Seeker profiles and join requests are removed.
  Refused: a registration with an order or ticket type or `PENDING_PAYMENT`
  (*This person bought a ticket. Cancel or refund their order first.*), a
  team member, and an entrant with a hackathon project.
- The ticket page shows a **Crew** chip and *You're on the crew*, with no
  cancel, payment, transfer, refund, team or project controls; **Account →
  Registrations** shows *Crew* and offers no cancel.
- Designed tickets print `{{ticket}}` as *Crew* and `{{price}}` empty.
- The check-in desk, scanner, details dialog, search results, offline roster
  and venue station show a **Crew** badge and the crew food preference.
- ID badges: *Event crew* and *Confirmed attendees (no crew)* filters for
  bulk sheets; a crew badge prints the kind and role (*Volunteer · Role*, or
  the kind alone) in the team slot and the crew
  photo when it is a crew upload of the same organisation (storage key only).
- The attendee CSV marks crew in the *Ticket* column (and *Team role* on
  team events), so columns keep their positions.
- Attendance confirmation ([ATTENDANCE.md](ATTENDANCE.md)) never asks crew;
  adding an asked guest to the crew deletes their question and its link.
- Removing a crew member deletes their ticket (and its check-in) with the
  crew row. Event cancellation notifies crew like everyone with a place.

## Webhooks and chat

The registration DTO in every registration and check-in webhook carries
`crew: boolean` ([Webhooks](WEBHOOKS.md)). Adding a crew member emits
`registration.created` after the commit, or `registration.status_changed` to
`CONFIRMED` with `crew: true` when an existing registration was converted
(even one that was already confirmed, so `previousStatus` may also be
`CONFIRMED`); removing one emits `registration.status_changed` to
`CANCELLED`. Removing an account-tied crew member (their own registration,
converted) also emails them that their crew ticket no longer works. Sign-ups
through the crew link post a *Registrations* chat notice
(*Asha joined the crew for …*).

## Crew join link

Organisers can share a sign-up link (`/crew/:token`) so crew add themselves.

- The token is 32 random bytes, base64url, **stored as-is** like team join
  tokens: organisers can show it again from Guests → Crew. It is a bearer
  capability: never log it or put it in analytics or audit metadata.
- **Create** keeps an existing link, **Replace** rotates the token (the old
  link stops working at once), **Turn off** deletes it. Each is audited
  (`EVENT_CREW_LINK_CREATED`, `_ROTATED`, `_DISABLED`, event id only).
- Values that are not token-shaped are refused before any lookup. The page
  shows only the event and organisation names and the date; its metadata is
  generic, and it is `noindex`, `no-referrer` (header and meta), private
  no-store (`lib/pageSecurity.ts`), and disallowed in `robots.txt`. `crew` is
  a reserved organisation slug.
- Sign-ups are refused once the event is cancelled or has ended.
- People who join through the link start **hidden** (`showOnPage = false`,
  `joinedViaLink = true`) until an organiser reviews them. The public form
  cannot set its own visibility.
- **No enumeration:** an email that is already on the crew, or that already
  has a registration for the event, gets the same answer as a new sign-up and
  nothing changes. The link proves nothing about who owns an email, so it
  never converts a registration; organisers do that from Guests → Crew. The
  confirmation says so for everyone.
- Sign-ups use the `rsvp` rate-limit bucket per IP and per email. Photo
  uploads through the link use their own `crewPhotoUpload` bucket (60 an hour)
  per IP and per link (hashed), never the shared `upload` budget, and at most
  200 a day per event (`crewPhotoUploadEvent`). Photos are uploaded before the
  form is saved, so the hourly retention pass deletes any `event-crew` upload
  no crew member points at after a day (`purgeUnusedCrewPhotos`, safe to run
  twice). Link
  sign-ups are audited as `EVENT_CREW_JOINED_WITH_LINK` (event id only).

## Public Crew section

The event page gains a **Crew** section, listed in **Event page → Sections**,
whose *Manage in Guests* link opens Guests → Crew. It starts switched off and
last for every event, so nothing is published until an organiser turns it on
there, or with **Turn on Crew section** in Guests → Crew (`showCrewSection`,
`EDIT_DETAILS`, audited as `EVENT_PAGE_UPDATED`). It shows only members with
`showOnPage`, as cards with name, role, bio, photo and LinkedIn link
(`listPublicCrew`); never the email, food preference or ticket.

## Expense claims

When an owner or admin turns on *Let crew claim expenses* in the Finance tab
(`Event.crewClaimsEnabled`), a crew member's ticket page shows **Claim
expenses**. Claims go through the participant claims path
(`submitParticipantClaim`) with kind `CREW`, no cap, and the usual receipts;
owners and admins approve, reject and pay them, and the Finance list labels
them *(crew)*. See [Event finance](FINANCE.md).

## Permissions

Everything in Guests → Crew (list, food summary, add, edit, show/hide,
reorder, remove, photo upload, the sign-up link) needs the guest-list
permission: organisation owners and admins, or a co-organiser with
`MANAGE_REGISTRATIONS` (`canManageCrew` in
`lib/eventDashboard/capabilities.ts`; `resolveOrganiserEvent` in
`app/actions/crew.ts`, which also applies the staff authenticator check).
Organiser actions use the dashboard `action` rate-limit bucket (organiser
photo uploads the `eventPageUpload` one) and are audited with ids only
(`EVENT_CREW_MEMBER_ADDED`, `_UPDATED`, `_REMOVED`,
`EVENT_CREW_PHOTO_UPLOADED`). Every core in `lib/core/crew/` re-scopes the
member or link to the event and organisation, so ids from another tenant are
"not found".

## What the other flows refuse

- Self-cancel of a crew ticket (`app/actions/rsvp-cancel.ts`).
- Guests · People edit, remove, approve, decline and give-a-spot
  (`app/actions/rsvp-admin.ts`, `app/actions/rsvp-lifecycle/helpers.ts`):
  *This person is on the event crew. Manage them from Guests → Crew.*
- A registration, checkout, ticket transfer or guest-email change to an email
  already on the crew (`hasCrewEmail` in `reserveRsvp`, `reserveOrder`,
  `transferTicket` and `updateRsvpRegistration`).
- Team joins, *Looking for a team* listings, join requests and organiser
  moves (`lib/core/teams/*` filter `isCrew: false`).
- Hackathon projects: crew are not entrants, cannot draft, submit or pay an
  entry fee, cannot request a submission link, and are not listed under *Not
  submitted* (`lib/core/judging/entrantAuth.ts`,
  `lib/core/judging/entrantSubmissions.ts`, `lib/core/judgingEntrants.ts`).
  Prizes follow projects, so crew never win one.

## Code and tests

Cores: `lib/core/crew.ts` (entry) over `lib/core/crew/{shared,members,joinLink,public}.ts`.
Server Actions: `app/actions/crew.ts` (helpers in `app/actions/crew/`) and
`showCrewSection` in `app/actions/event-website.ts`. Dashboard data:
`lib/eventDashboard/crew.ts`. Join page: `app/crew/[token]/page.tsx` with the
view reader `lib/views/app__crew__token__page.ts`. Email: `lib/outbox/crew.ts`,
`lib/email/crew.ts`.

Unit suites: `crew` (schemas, tokens, food summary, `hasCrewEmail`),
`crew-email`, `crew-outbox`, `crew-migration`, `crew-surfaces` (no-store,
robots, reserved slug, desk details, badges, page section) and the capacity
expectations in `team-units`, `rsvpCapacity`, `paid-ticket-helpers`,
`event-page-summary`, `webhooks` and `upload-rate-limits`. PostgreSQL suites:
`crew.db.test.ts`, `crew-link.db.test.ts`, `crew-guards.db.test.ts`,
`crew-paid.db.test.ts`. Hand-test conditions: [CREW_TEST_CONDITIONS.md](CREW_TEST_CONDITIONS.md).
