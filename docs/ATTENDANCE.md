# Attendance confirmation ("Are you still coming?")

A final check before an event, sent by hand from the event's **Emails** tab.
Nothing is ever sent automatically: there is no schedule or timer, and the
outbox worker never creates a question. Most organisers send it a day or two
before the event, but it is always their decision.

Ported from Yuyu (`b449c1f5`, `4bf509ef`, `9c722118` and their docs), with
Space Works rules for paid tickets.

## Who can do what

- **Send, remind, change the release switch, share a guest's link:**
  organisation owners and admins only, the same rule as custom emails
  (`canManageEvents` after the staff authenticator check). No co-organiser
  grant covers emailing guests, so every grant (`JUDGE` and "all grants"
  included) is refused with "You do not have permission to email attendees."
  The Emails card and the Overview line are not shown to them.
- **See replies in Guests → People, filter by them, export them:** whoever
  manages registrations (owners, admins, `MANAGE_REGISTRATIONS`).
- **Check-in desk and station:** see the reply as a badge (never the note).
- **The guest:** answers on `/attend/:token`; the link is the only credential.

## Who is asked

Every **CONFIRMED registration of a one-off event**, one email per person (each
team member individually), to the registration's own address. Waitlisted,
pending-approval, pending-payment, rejected and cancelled registrations are
never asked, and neither are **series dates or passes** (their registrations
belong to an `EventInstance`, and a check always points at an `Event`).

The rule lives in one function, `attendanceEligibleRsvpWhere`
(`lib/attendanceEligibility.ts`), used by sending, reminders, shared links,
delivery, replies, the card counts and the Guests filters. Event crew (a later
branch) adds `isCrew: false` there.

## Sending

- **Ask guests to confirm attendance** first shows a read-only preview (how
  many guests, the event date, and that each email counts towards the sending
  limit) and sends only after an explicit confirmation. Each send creates one
  `AttendanceCheck` per registration and queues one `attendance-check` outbox
  email. The unique `rsvpId` plus the event row lock make it idempotent: a
  double click or two organisers at once never ask anyone twice.
- Later the button reads **Ask newly confirmed guests** and asks only people
  confirmed since (for example, promoted from the waitlist).
- **Remind people who haven't replied** emails eligible guests without a
  reply again, at most **once every 12 hours** each, and **rotates the link**:
  the earlier one stops working and its still-queued email is dropped.
- **Share attendance link** (Guests → People, a confirmed guest's menu) issues
  that guest's link to send by hand, without an email. Only the digest is
  stored, so each click issues a new link: a guest not yet asked counts as
  asked (later sends skip them); for a guest already asked the new link
  replaces the emailed one.
- Everything is refused once the event has started and for a cancelled event.
- Sends and reminders share a limit of 10 per hour (`attendanceCheckSend`),
  shared links 60 per 10 minutes (`attendanceCheckLink`), the switch 30 per
  minute, replies 10 per minute per link and per address.

## The email

Subject "Are you still coming to {event}?" ("Reminder: are you…" for
reminders), with the date and time in the event's own time zone, the place
(or "Online"), and two buttons (**Yes, I'll be there** / **No, I can't make
it**) that open the form with that answer preselected. Links use the absolute
`NEXT_PUBLIC_BASE_URL`. At delivery a question is dropped if its link was
replaced, the guest already answered, is no longer eligible, or the event was
cancelled, and it expires when the event starts.

The email says a No gives up the place **only when release is on and that
registration would actually be released right now** (computed at delivery by
`releaseKindFor`): free places, and paid single tickets whose buyer is replying
while the refund policy still allows a cancellation. It never promises the
waitlist.

## The guest's form (`/attend/:token`)

The event summary, the guest's own name, email and team (read only), Yes or
No, and an optional note of up to 500 characters (control characters removed).
The answer can be changed until the event starts. After the start, after a
cancellation, or when the registration is no longer confirmed, the page shows
a closed message. Unknown, malformed, rotated and released tokens are a real
404. The page is `noindex`, `no-referrer` (header and meta), `private,
no-store`, and disallowed in `robots.txt`; "attend" is a reserved organisation
slug.

## "Free the place when a guest says No"

Off by default; cloning an event copies the switch, never the questions. With
it on, a No is handled after the reply has been recorded
(`lib/core/attendanceCheck/release.ts`):

| Registration | What a No does |
| --- | --- |
| Free (no order, or nothing collected on it) | The guest's own cancellation (`cancelRegistrationByToken` in `lib/rsvpCancel.ts`, without revalidation): capacity, waitlist promotion and team rules (leader handover, team units) apply as on the ticket page. |
| Paid order with only this ticket, the replier is the buyer, refund policy open | The buyer's own cancellation (`cancelOrderAsBuyer`), refunding what the policy says, after the reply commits. |
| The same, refund policy closed | The place is kept and a refund request is opened for the organisers (`requestRefundForOrder`; an already open request is reused). Guests shows **Said No · paid**. |
| Paid order with several tickets, a team ticket covering the whole team, or a ticket somebody else paid for | Nothing is cancelled. Owners and admins are emailed and the chat hears a cancellation notice; Guests shows **Said No · paid**. |
| Already checked in, or any refused cancellation | The place is kept; the reply is recorded with `releaseOutcome = "failed"`. |

The guest path never refunds "everything" by default: only `cancelOrderAsBuyer`
with the policy's amount is used. What happened is stored in
`AttendanceCheck.releaseOutcome` (`multiTicket`, `notBuyer`, `refundRequested`,
`failed`; a CHECK keeps it to a No). A later Yes clears it; a repeated No on a
place already with the organisers is not handled twice.

## What organisers see

- **Emails tab card:** "Not sent yet" or how many guests were asked, when and
  by whom the last email went (event time zone), coming / not coming / no
  reply / newly confirmed and not asked, places released, and when the next
  reminder becomes possible.
- **Overview:** a counts-only line ("Attendance: 12 coming · 3 not coming · 5
  no reply") for owners and admins once anyone was asked.
- **Guests → People:** a badge per guest (*Coming*, *Not coming*, *Said No ·
  paid*, *No reply*, *Not asked*), the guest's note, what happened to a paid
  No, and an **attendance** filter with counts (saved views and links keep
  `attendance=`). The status chips stay event-wide.
- **Attendee CSV:** **Attendance confirmation** and **Attendance note** columns
  at the end (formula-safe); the export takes the same `attendance` filter.
- **Check-in desk, station and offline roster:** the reply badge only.
- **Personal data export:** the user's own questions and answers (asked at,
  reply, replied at, note).

## Data and audit

`AttendanceCheck` (one per registration, cascading with the registration and
the event) stores the SHA-256 digest of the 256-bit token, `sentAt`, the reply,
its time, the note and `releaseOutcome`. CHECK constraints keep the digest
shape, the note length, the reply/time pair and the release outcome. Sends,
reminders, setting changes, shared links, released places and kept paid places
are audited (`ATTENDANCE_CHECK_SENT`, `_REMINDED`, `_SETTINGS_UPDATED`,
`_LINK_SHARED`, `_RELEASED`, `_PAID_KEPT`) with counts and ids only, never a
token or a note.

## Code map

| Piece | Where |
| --- | --- |
| Pure rules, labels | `lib/attendanceCheck.ts`, `lib/attendanceEligibility.ts`, `lib/attendanceToken.ts`, `lib/attendeeAttendance.ts` |
| Send, remind, switch | `lib/core/attendanceCheck/send.ts` |
| Shared link | `lib/core/attendanceCheck/link.ts` |
| Card status, Overview counts, preview | `lib/core/attendanceCheck/status.ts`, `lib/eventDashboard/attendanceCheckCard.ts` |
| Reply, form view | `lib/core/attendanceCheck/reply.ts` |
| Release on No | `lib/core/attendanceCheck/release.ts`, `releaseRun.ts`, `lib/rsvpCancel.ts`, `lib/refundRequests.ts` |
| Email and outbox kind | `lib/email/attendance.ts`, `lib/outbox/attendance.ts` |
| Server Actions | `app/actions/attendance-check.ts` |
| Page | `app/attend/[token]/page.tsx`, `lib/views/app__attend__token__page.ts`, `components/attendance/` |
| Dashboard | `components/event-dashboard/emails/AttendanceCheckCard.tsx`, `guests/AttendanceLinkDialog.tsx`, `GuestRow.tsx`, `panels/GuestsPeople/Toolbar.tsx` |

Not covered yet: series dates and passes, the mobile API, and any automatic
sending (see `docs/FUTURE_PHASES.md`).
