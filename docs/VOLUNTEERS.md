# Volunteer shifts and contributor hours

[Documentation index](README.md)

Volunteers are [event crew](CREW.md). When an organiser turns on volunteer
shifts, crew sign up for shifts from their crew ticket, the attendance desk
checks them in and out of each shift, an owner or admin who is not the
volunteer verifies their hours, and owners and admins issue contributor
certificates. This page is the design contract. It follows the Space Works
platform's contributions design (`backend/apps/events/contributions/` on
SpaceWorks `dev`: `models_shifts.py`, `shift_workflow.py`,
`attendance_workflow.py`, `allocation.py`, `certificate_subjects.py` and the
certificate `contribution_proof.py`); [Parity](#parity-with-space-works) lists
where each rule lives and the deliberate differences.

## Scope and principles

- One-off events with crew only. Every shift row is keyed by `eventId` and
  every core re-scopes to the event's organisation, so another tenant's ids
  are "not found".
- **Crew kind never grants authority.** `EventCrewMember.kind`
  (`ORGANISER`, `VOLUNTEER`, `MENTOR`, `JUDGE`) is for display, ID badges and
  the crew list filter. Dashboard access comes from organisation membership or
  collaborator grants; a volunteer's own actions come from their shift
  sign-ups through their crew ticket. Any crew member may sign up for shifts.
- **Shift attendance is not event check-in.** Checking in to a shift never
  touches `RSVP.checkedInAt`, and the event check-in never touches shifts.
- **Hours are never money.** No payment, payout, price or claim amount is
  derived from hours. Crew expense claims (`ExpenseClaimKind.CREW`,
  `Event.crewClaimsEnabled`, see [Finance](FINANCE.md)) are shown beside a
  person's hours in the dashboard and nothing more.
- Off by default: `Event.volunteerShiftsEnabled`.

## Data model

| Model / field | Meaning |
| --- | --- |
| `EventCrewMember.kind` | `CrewKind`, default `VOLUNTEER`. Display, badges, filters only. |
| `EventCrewMember.userId` | Optional account link (`ON DELETE SET NULL`). Set from a converted registration's account, from a verified account with the crew email when the member is added or their email changes, and when that email accepts a collaborator invitation for the event (`linkCrewAccount`). Used to stop self-verification and for the Mentor Desk; never grants anything. |
| `EventCrewJoinLink.kind` | The kind link sign-ups get (default `VOLUNTEER`). |
| `Event.volunteerShiftsEnabled` | Shows shifts on crew tickets and allows volunteer actions. |
| `Event.contributorCertificateTemplate` | The contributor certificate design (layered template, `lib/certificateTemplate.ts`); null uses the standard one. |
| `VolunteerShift` | `title` ≤120, `zone` ≤100, `task` ≤200, `startsAt`, `endsAt` (≤12 hours later), `signupDeadline` ≤ start, `capacity` 0–10,000 (0 = no limit), `waitlistEnabled`, `requiresApproval`, `graceMinutes` 0–60, `closed`. CHECK `VolunteerShift_shape`. |
| `VolunteerShiftSignup` | One per (shift, crew member) (unique). `status` `APPLIED`/`WAITLISTED`/`APPROVED`/`WITHDRAWN`/`DECLINED`, `queuedAt` (FIFO), `approvedAt`, `approvedByUserId` (null for automatic), and attendance: `attendance` `SCHEDULED`/`CHECKED_IN`/`CHECKED_OUT`/`NO_SHOW`, `checkedInAt`, `checkedOutAt`, `breakMinutes`, `attendanceSource` (`self`/`desk`). CHECK `VolunteerShiftSignup_attendance_shape`: attendance other than `SCHEDULED` only on `APPROVED`, timestamps match the state, check-out not before check-in, breaks 0–720. |
| `VolunteerAttendanceCorrection` | Append-only: a desk-entered time with its reason (`check-in`/`check-out`, reason 1–500). |
| `VolunteerHours` | One per checked-out sign-up: `minutes` 0–1440, `state` `PENDING`/`VERIFIED`/`ADJUSTED`, `version`. |
| `VolunteerHoursEntry` | Append-only history: `actorUserId`, `previousVersion` (unique per hours row), `minutes` 0–1440, `kind` `VERIFIED`/`ADJUSTED`, `reason` (required for `ADJUSTED`). |
| `ContributorCertificate` | `token` (32 random bytes, base64url, a bearer capability), snapshots of `role`, `kind`, `minutes` and `template`, `issuedByUserId`, `revokedAt`/`revokedReason`. Partial unique index `ContributorCertificate_one_live_per_member`: one live certificate per crew member. |

Database guards (migration `20261114000000_volunteer_shifts`, listed in
`npm run db:verify`):

- `volunteer_hours_entry_guard`: entries are never updated; deleted only when
  their hours row is already gone (cascade); an insert must match the hours'
  event and is refused when the actor is the volunteer (their linked account,
  or an account with the crew email). Second-person verification holds even
  if the application check were skipped.
- `volunteer_hours_guard`: hours change only with the entry that records the
  change (version + 1, an entry for the previous version with the new minutes
  and state, never back to `PENDING`), never move to another sign-up or event,
  and are deleted only with their sign-up.
- `volunteer_correction_append_only`: corrections are never updated, deleted
  only with their sign-up.

Removing a crew member or deleting the event removes their sign-ups, hours,
history and certificates through the cascades.

## Shifts and sign-ups

Cores: `lib/volunteer/shifts.ts`, `lib/volunteer/signups.ts`.

- **Locks.** Every place decision locks the shift row, then the crew member
  row (`lockShift`, `lockCrewMember`), so places are counted and overlaps
  checked under the lock. Concurrent sign-ups never exceed `capacity`. A
  withdrawal locks the withdrawer and everyone waiting on the shift, and a
  promotion everyone waiting, in one id-ordered statement
  (`lockCrewMembers`), so withdrawals on two shifts with crossed waitlists
  wait for each other instead of deadlocking. No path locks a crew member
  before a shift.
- **Apply** (volunteer, from their crew ticket): shifts on, event not
  cancelled, shift open and not closed, before `signupDeadline`, crew ticket
  confirmed. One sign-up per shift; someone who withdrew may sign up again
  (new `queuedAt`); a declined sign-up stays declined. Without approval the
  sign-up is approved at once, or waitlisted when full (refused "This shift is
  full." when the waitlist is off); with approval it waits as `APPLIED`.
- **Approve** (organiser): `APPLIED`/`WAITLISTED` only, before the shift
  starts and while open. Refused when the volunteer holds an approved place
  on an overlapping shift (half-open intervals, so back-to-back shifts are
  fine). When full, the sign-up joins the waitlist instead.
- **Decline** (organiser): `APPLIED`/`WAITLISTED` → `DECLINED`.
- **Withdraw** (volunteer) or **Cancel place** (organiser): before any
  attendance (`SCHEDULED`); otherwise "Work has started on this shift".
- **FIFO promotion** (`promoteLocked`): while the shift is open and has not
  started, waitlisted sign-ups are approved by `queuedAt`, then id, while
  places are left, skipping anyone whose crew ticket no longer works or who
  now has an overlapping approved shift. Runs after a place is freed, after
  places are added or the shift is edited, and when a closed shift reopens.
- **Edit**: places never below the approved count; the window and grace are
  fixed once anyone has attendance. **Close/reopen**. **Delete** only while
  every sign-up is still `SCHEDULED`; volunteers with a place or on the
  waitlist are told it is cancelled. At most 200 shifts per event.

## Attendance

Core: `lib/volunteer/attendance.ts`; arithmetic in `lib/volunteer/math.ts`.

- **Check-in** (volunteer at the current time, or the desk): `APPROVED` and
  `SCHEDULED`, from `graceMinutes` before the start until the end, and only
  when the person has no other shift `CHECKED_IN` (one active duty).
- **Check-out**: from `CHECKED_IN`, within the shift and its grace on either
  side (a volunteer who misses it asks the desk). Minutes are whole minutes
  between check-in and check-out less `breakMinutes`
  (`countedMinutes`); breaks longer than the time on duty are refused. The
  interval must not overlap time already recorded for another of the
  person's shifts. Creates `VolunteerHours` in `PENDING`.
- **Desk times**: the desk may enter a past time instead of now, with a
  reason, kept as a `VolunteerAttendanceCorrection`; never a future time.
  Only the desk records breaks.
- **No-show**: the desk, after the shift ends, for `APPROVED` +
  `SCHEDULED`.

## Hours verification

Core: `lib/volunteer/hours.ts`.

- **Verify**: organisation owner or admin only, never the volunteer
  (`isVolunteerSelf`: their linked account or the crew email; the database
  trigger refuses it too). `PENDING` → `VERIFIED`, minutes recomputed from
  the attendance.
- **Adjust**: same people, `VERIFIED`/`ADJUSTED` → `ADJUSTED`, whole minutes
  0–1440 and a reason (1–500).
- Each change writes the `VolunteerHoursEntry` first, then the hours row, in
  one transaction under the crew member and hours row locks, and revokes the
  member's live certificate (`revokedReason` `hours_changed`).
- A crew member's **verified minutes** are the sum of `VERIFIED`/`ADJUSTED`
  hours of checked-out sign-ups; pending hours never count.

## Contributor certificates

Core: `lib/volunteer/certificates.ts`; image: `lib/volunteer/certificateImage.ts`.

- Owner/admin only, never for themself. The crew ticket must be confirmed.
- A certificate needs verified minutes above zero, or **mentoring evidence**
  (`lib/volunteer/mentoring.ts`): the crew record is linked to an account
  that holds the event's `MENTOR` grant and has an assignment that was ever
  active (`activatedAt`), a help request it resolved, or a non-away
  mentoring-round check-in. A role or kind alone never proves work. Ending
  the `MENTOR` grant (`endMentorRoleLocked`) revokes a mentoring-only
  certificate (`mentoring_evidence_removed`), and the download re-checks the
  evidence.
- One live certificate per member (the partial unique index decides races).
  The certificate snapshots `role` (`"<Kind> · <role>"`, or the kind), the
  verified minutes and the design.
- The layered renderer (`lib/renderCertificate.ts`) gains `{{role}}` and
  `{{hours}}` merge tags ("6.5 hours"); attendee certificates fill them with
  nothing, and the feedback certificate builder hides them. The standard
  design is "Certificate of contribution".
- Download `/api/crew/certificate/:token`: token shape checked first; a
  revoked certificate, a removed member, an unconfirmed crew ticket, or
  minutes that no longer match the verified minutes are a 404. `private,
  no-store`, `no-referrer` (header in `next.config.ts` too), `nosniff`. The
  link is shown only on the member's crew ticket.
- **Revoke** by an owner or admin, or automatically when hours change.

## Email

Outbox kind `volunteer-notice` (`lib/outbox/volunteer.ts`,
`lib/email/volunteer.ts`): transactional (not a bulk kind), sent as the
organisation, and deleted after delivery because it links the crew ticket.
The payload carries ids (plus, for a cancellation, the shift's title, zone and
times, since the row may be gone). Notices:

| Notice | When | Dropped at send time when |
| --- | --- | --- |
| `approved` | Approved by an organiser, or on sign-up without approval | the sign-up is no longer `APPROVED` |
| `promoted` | Promoted from the waitlist | the sign-up is no longer `APPROVED` |
| `cancelled` | An organiser cancels a place (not an application) or deletes a shift | — |
| `certificate` | A certificate is issued | no live certificate |

All are dropped when the crew member is gone, their ticket is not confirmed,
the event is cancelled or belongs to another organisation. A volunteer's own
withdrawal sends nothing. No webhook carries shift, hours or certificate
data, and no chat notice is posted.

## Surfaces

- **Guests → Crew → Shifts** (`components/event-dashboard/crew/shifts/`,
  data `lib/eventDashboard/volunteerShifts.ts`): the on/off switch, shift
  editor, roster with approvals and the attendance desk, **Hours** (verify,
  adjust, **Download hours CSV**) and **Contributors and certificates**
  (verified hours, pending count and crew expense claims per person; design,
  issue, revoke). Buttons are hidden for the viewer's own hours and
  certificate; the actions refuse them anyway.
- **Crew list**: a kind chip and kind filter; the member dialog and the
  sign-up link card set the kind.
- **ID badges** print the kind and role in the team slot ("Volunteer ·
  Registration desk").
- **Crew ticket → My shifts** (`components/ticket/MyShifts.tsx`, data
  `lib/volunteer/ticketView.ts`): open shifts with places left, own sign-ups
  with status, self check-in/out, withdraw, verified total and the
  certificate download.
- **Hours CSV** `/api/exports/events/:eventId/volunteer-hours`: one row per
  sign-up (name, kind, shift, zone, times, status, attendance, break,
  minutes, hours, state). Names only: no emails, tokens or adjustment
  reasons. Cells are formula-neutralised (`lib/csv.ts`). Audited
  `VOLUNTEER_HOURS_EXPORTED` with a row count.

## Permissions

| Action | Who |
| --- | --- |
| Turn shifts on/off, create/edit/close/delete shifts, approve/decline/cancel sign-ups, attendance desk, no-show, hours CSV | Owners and admins, or a co-organiser with `MANAGE_REGISTRATIONS` (`canManageCrew`; `resolveOrganiserEvent`, which also applies the staff authenticator check) |
| Verify and adjust hours; design, issue and revoke certificates | Organisation owners and admins (`getMembership` + `isOrgAdmin`, staff MFA), never for their own crew record |
| Apply, withdraw, check in/out of own sign-ups | The crew member, through their crew ticket token (`myShiftAction`); an account-tied ticket also needs that account signed in. Rate limited per ticket (`action` bucket). |

Organiser actions use the dashboard `action` rate-limit bucket per user and
are audited with ids only: `VOLUNTEER_SHIFTS_ENABLED`/`_DISABLED`,
`VOLUNTEER_SHIFT_CREATED`/`_UPDATED`/`_CLOSED`/`_REOPENED`/`_DELETED`,
`VOLUNTEER_SIGNUP_APPROVED`/`_DECLINED`/`_CANCELLED`,
`VOLUNTEER_CHECKED_IN`/`_CHECKED_OUT`, `VOLUNTEER_NO_SHOW`,
`VOLUNTEER_HOURS_VERIFIED`/`_ADJUSTED`, `CONTRIBUTOR_CERTIFICATE_ISSUED`/
`_REVOKED`/`_DESIGN_SAVED`. Volunteer actions are audited as
`VOLUNTEER_SIGNUP_APPLIED`/`_WITHDRAWN` and `VOLUNTEER_CHECKED_IN`/`_OUT`
with `source: self` and no actor. Reasons, names, emails and tokens never
enter audit metadata.

## Parity with Space Works

| Space Works rule | Here |
| --- | --- |
| `EventShift` window, deadline ≤ start, grace ≤ 60 (`event_shift_window`, `_deadline`, `_grace_bound`) | `VolunteerShift_shape` CHECK and `shiftInputSchema` |
| Capacity 0 = no limit; capacity never below allocations (`allocation.py`) | `placesLeft`, `updateShift` |
| Sign-up states applied/waitlisted/approved/withdrawn/declined, unique (shift, member) | `VolunteerSignupStatus`, `@@unique([shiftId, crewMemberId])` |
| Apply only while open and before the deadline; auto-approve without approval; waitlist or `shift_full` | `applyForShift` |
| No overlapping approved duty (`conflicts`) | `hasOverlappingDuty` under the crew member lock |
| Approve only before start and while open; full → waitlisted | `approveSignup`/`approveLocked` |
| FIFO promotion by `queue_at`, skipping ineligible and conflicting | `promoteLocked` |
| Withdraw refused once work started | `withdrawSignup` |
| Attendance separate from check-in; scheduled/checked_in/checked_out/no_show | `VolunteerAttendanceState`; RSVP check-in untouched |
| Self check-in at now within grace; staff time with reason (correction log) | `checkInToShift`/`checkOutOfShift`, `VolunteerAttendanceCorrection` |
| One active duty; counted intervals never overlap | `checkInToShift`, `checkOutOfShift` |
| minutes = elapsed − breaks; break > elapsed refused | `countedMinutes` |
| No-show only after the shift ends | `markNoShow` |
| Hours pending → verified/adjusted via append-only entries, `(hours, previous_version)` unique | `VolunteerHoursEntry`, triggers |
| Second person verifies (`self_verification_forbidden`) | `isVolunteerSelf` + `volunteer_hours_entry_guard` |
| Adjust needs a reason, ≤ 1440 | `adjustHours`, `VolunteerHoursEntry_shape` |
| Certificate needs independently verified minutes > 0; labels prove nothing | `issueContributorCertificate`, `verifiedMinutes` |
| Evidence change invalidates the certificate (`invalidate_role_locked`) | `revokeCertificatesLocked` on verify/adjust; download re-checks minutes |
| Notices: approval and cancellation | `volunteer-notice` outbox kind |

Deliberate differences:

- **Volunteers are crew.** No role postings or role assignments
  (`EventRoleAssignment`): a crew member signs up directly, and the crew
  ticket replaces contributor admission. Kind is a label, not a role
  lifecycle.
- **Attendance lives on the sign-up** instead of a one-to-one attendance
  table; same states and rules.
- **Re-applying after withdrawal** is allowed (the source refuses any second
  sign-up); a declined sign-up still cannot re-apply.
- **Shifts are at most 12 hours**, so counted minutes always fit the 1440
  entry bound.
- **Verification and certificates are owner/admin**, the existing finance
  approval rule, rather than a separate `manage_volunteers` permission; the
  rest follows the crew rule.
- **No reminder schedule** (week, two days, day of): one email per decision.
  Volunteers' own withdrawals send no receipt.
- **No requirements, training or waiver checks, permission presets,
  operation ids or expected versions**: Server Actions run in one
  transaction under row locks, and the database constraints decide races.
- Office hours, mentor assignment, help queues and mentoring rounds belong to
  the Mentor Desk branch.

## Notes for other branches

- **Mobile** ([Mobile API](MOBILE_API.md#volunteer-shifts-volunteersmd)):
  crew `GET /me/registrations/:rsvpId/shifts` and
  `POST …/shifts/:id/:action`; organiser `GET …/volunteer-shifts`,
  `POST …/volunteer-shifts/signups/:signupId/:action` and (owner/admin)
  `POST …/volunteer-shifts/hours/:hoursId/:action`, over the same actions.
- **Mentor Desk**: `syncMentorCrewAfterGrant` gives the mentor's crew place
  kind `MENTOR` and links it to the mentor's account (`linkCrewAccount`, also
  on invitation acceptance and for an existing crew place). Mentors never
  gain authority from `kind`; their console access comes from the `MENTOR`
  grant.

## Code and tests

Cores `lib/volunteer/{math,shared,shifts,signups,attendance,hours,certificates,certificateImage,ticketView,export}.ts`;
labels `lib/crewKind.ts`; actions `app/actions/volunteer-shifts.ts` (helpers
in `app/actions/volunteer-shifts/`) and `app/actions/my-shifts.ts`; routes
`app/api/crew/certificate/[token]` and
`app/api/exports/events/[eventId]/volunteer-hours`.

Unit `volunteer-math` (minutes, breaks, half-open overlaps, windows, places,
labels, merge tags). PostgreSQL suites `volunteer-signups.db.test.ts`,
`volunteer-hours.db.test.ts`, `volunteer-certificates.db.test.ts`,
`volunteer-permissions.db.test.ts` (see [Testing](TESTING.md)).
