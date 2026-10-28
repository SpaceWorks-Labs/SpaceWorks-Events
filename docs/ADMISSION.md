# Applications and shortlisting

Applications turn registration into an application that is reviewed in
stages before a place is offered. They work on **any one-off event**
(conferences, workshops, fellowships, hackathons), free or paid, individual
or team registration. Recurring series can't take applications: their
registrations are per date. The rules follow Space Works' hackathon
admission (SpaceWorks `backend/apps/events/hackathons/admission_*.py`,
`review_*.py`); multiple stages, per-stage reviewer panels and seeded random
assignment are Space Works Events extensions built the way judging rounds
are (`docs/HACKATHON.md` "Rounds").

User-facing wording is general everywhere ("Applications", "Your
application", "Apply"); nothing in the flow is hackathon-specific. Teams,
entry fees and judging appear only on events that use them.

Code: `lib/admission/*` (rules, cores), `app/actions/admission.ts`
(organiser), `app/actions/admission-applicant.ts` (applicant and reviewer),
`components/event-dashboard/admission/*`, `components/ticket/TicketApplicationCard.tsx`,
`lib/outbox/admission.ts`, `lib/api/v1/applications.ts`. Schema:
`prisma/schema.prisma` (`Admission*` models), migrations
`20261117000000_admission_permission`, `20261117010000_hackathon_admission`,
`20261117020000_admission_guards`, `20261117030000_admission_retention`.

## Setting up

- Owners and admins turn applications on in **Settings → Applications and
  shortlisting** (`setAdmissionEnabled`), only while the event has no
  registrations (crew aside), so every registration is an application or
  none is. Turning off has the same rule.
- On makes the event `APPROVAL_REQUIRED` and adds stage 1, "Review", open. A
  CHECK (`Event_admission_shape`) keeps the event approval-only while
  applications are on; `updateEvent` refuses a privacy change with a message.
- Settings (`updateAdmissionSettings`, owners/admins): `admissionMode`
  MANUAL (released batches) or AUTO (offered on arrival while offers last,
  then waitlisted, by the beat), `admissionRsvpDays` 1..30,
  `admissionOfferCapacity` (null uses `Event.capacity`, null again means no
  limit), `emailApplicantsOnStageAdvance` (default off).
- Paid team events must use PER_TEAM (the leader pays once). Enabling is
  refused on a TEAM event with paid tickets in PER_MEMBER mode, switching to
  PER_MEMBER is refused while applications are on, and a PER_MEMBER paid
  order on an admission event is refused at checkout. Paying per member is
  deferred: it needs an all-or-nothing gate (every member held until the
  last pays, the team confirmed atomically, all refunded at the deadline)
  that bends the "member status = team status" invariant.
- Each application is one person (a solo registrant) or one team. Orders of
  more than one seat are refused on admission events.

## Applications

`AdmissionApplication` has exactly one of `rsvpId` / `teamId` (CHECK), each
unique. Database triggers make it with the registration
(`rsvp_admission_application`, `team_admission_application`), so no
registration path (guest, account, team create/join, organiser add, order)
can skip review. A crew ticket never becomes an application
(`admission_application_shape` and the insert trigger skip `isCrew`). A solo
registrant who joins a team loses their solo application (discarded only when
nobody touched it in the same transaction, as when a paid leader's
registration is placed just before its team; else WITHDRAWN); one leaving a
team gets a solo application.

## Retention and one application per person

- Deleting a registration or a team, by any path (the applicant cancelling,
  a full refund, an organiser removing a guest or deleting a team, an ended
  hold replaced by a new order, attendance "No"), **withdraws and detaches**
  its application (`admission_withdraw_on_delete`, FKs SET NULL). The
  application keeps `subjectName` and `applicantKeys` (every attendee key
  ever in it), and its reviews, decisions, stage entries and answer
  revisions stay. Undo-restore of a removed applicant is refused.
- Reviews, answer revisions, stage entries, released (and cancelled)
  decisions and applications are deleted only with their event; an update
  may only clear a user link (an account deleted). A reviewer's deleted
  account leaves their reviews, which then no longer count.
- **One application per person per event**: a registration whose attendee
  key is already in an application of the event is refused
  (`admission_registration_guard`; friendly message from
  `admissionRegistrationRefusal`), whatever happened to that application.
- Registrations and teams on admission events are created **pending only**:
  organiser-added paid guests (paid by hand, waived or sent a link) are
  refused (`MANUAL_PAID_REFUSAL`), and nothing inserts a confirmed place.
- A team takes new members (join link, matching, organiser move) only while
  its application is **in review**; an applicant whose own application is
  closed or holds an offer joins no team. There is no way to reopen a decided
  team application yet (and its members can't apply again, one application
  per person), so organisers decide teams once their roster is final.

| Application | Registration(s) |
| --- | --- |
| IN_REVIEW | PENDING_APPROVAL (order REQUESTED when paid) |
| OFFERED | PENDING_APPROVAL; PENDING_PAYMENT while the accepted offer is being paid |
| WAITLISTED | WAITLISTED |
| ACCEPTED | CONFIRMED |
| REJECTED, DECLINED, EXPIRED, WITHDRAWN | REJECTED (unpaid order CANCELLED) |

`version` changes with every state change; `decisionRevision` counts released
decisions (emails carry it and are dropped when outdated); `answersRevision`
changes when the applicant edits answers.

## Stages

`AdmissionStage` (position, name, DRAFT/OPEN/CLOSED, reviewsPerApplication
1..20, blindReview, up to 10 criteria scored 1..5, guidance, planned
window). Every application enters stage 1 (`AdmissionStageEntry` source ALL);
an ADVANCE decision enters the next stage (source ADVANCED, by whom, with an
optional rank). Entries are append-only. Reviewers review only while a stage
is OPEN. Stages are added at the end; only the last one, with no entries or
decisions, can be deleted; stage 1 stays.

`applicationReachedStage(client, { eventId, stageId, rsvpId | teamId })`
(lib/admission/stages.ts) answers "reached stage N and still standing"
(IN_REVIEW, OFFERED, WAITLISTED or ACCEPTED); a team member's RSVP answers
for its team. Per-stage reimbursements key off it.

## Reviewers

- `EventPermission.REVIEW_APPLICATIONS` opens the review workspace and
  nothing else (one-off events only, like JUDGE). A collaborator whose grants
  are only REVIEW_APPLICATIONS (and possibly JUDGE) sees only their
  workspaces (`isReviewerOnly`). Owners and admins can review too. Staff MFA
  applies (`resolveAdmissionReviewer`).
- Each stage has its own panel (`AdmissionStageReviewer`). No panel: every
  REVIEW_APPLICATIONS collaborator (the UI says so). Panel members must hold
  the grant or be owners/admins.
- Assignment (`lib/admission/assignment.ts`) uses the planner shared with
  judging (`lib/assignmentPlanner.ts`): BALANCED (FNV ties) or RANDOM (stored
  32-hex CSPRNG seed, SHA-256 ties), applications sorted by id, conflicts and
  recusals never assigned, keep/replace (reviewed assignments always stay).
  Preview writes nothing; apply re-plans under the Event lock with the same
  seed and is refused if the plan fingerprint changed; a RANDOM preview
  without a seed re-rolls. Applied runs are stored (`AdmissionAssignmentRun`,
  CHECK seed iff RANDOM) and audited (`ADMISSION_REVIEWERS_ASSIGNED`).
  Manual assign/unassign is audited too.
- Conflicts: the reviewer's own application or their team's; every
  application when the reviewer applied to the event; declared conflicts
  (`AdmissionReviewConflict`). Recusing records a conflict and gives the
  application to the least-loaded panel reviewer left.
- Reviews (`AdmissionReview`) are append-only, one per assignment and answers
  revision. A review counts towards the stage target when it is on the
  current answers, by someone in the stage's pool now, without a conflict.
- Blind stages hide names, emails, phone and email answers and team names.

## Decisions

Organisers (owners/admins or MANAGE_REGISTRATIONS) draft decisions
(ADVANCE, ACCEPT, WAITLIST, REJECT) into the event's single DRAFT batch
(partial unique index), each with the application's `version`, its stage, an
optional note and override reason. `releaseDraftBatch` locks the Event and
releases all or nothing:

1. a decision whose application changed since drafting (version, stage, or
   an outcome that no longer fits) is **skipped**: it moves to a new draft to
   decide again, and the release reports how many (`skipped`); if every
   decision is stale, nothing is released;
2. every other decision meets its stage's review target, or has an override
   reason;
3. offers made fit the offers left (OFFERED + ACCEPTED against the offer
   capacity), and no offer is made once the event has started.

Released decisions are append-only (`admission_decision_guard`). The first
released decision locks the answers. Cancelling a batch keeps it for the
record (CANCELLED). Drafts (`ADMISSION_DECISIONS_DRAFTED`), releases, cancels
and every override with its reason (`ADMISSION_REVIEW_OVERRIDDEN`) are audited.

Once a stage has reviews its criteria, blind review and reviews per
application can't change (its name, status, guidance and window can), so
coverage always measures reviews against the rubric they were given. An
assignment with a review is never removed (manual unassign or a "replace"
run).

## Offers

ACCEPT makes the application OFFERED with `respondBy` = now +
`admissionRsvpDays`, never after the event starts; nothing is held or charged.
No offer is made once the event has started (release, promotion and AUTO
all stop). Organiser payment links and approvals refuse application orders
(`AdmissionManagedError`, code `ADMISSION_MANAGED`).
The applicant answers from their ticket page (the ticket token is the bearer,
rate limited), or an organiser answers for them (audited):

- **Free place** (no order, or an order totalling zero, including a free
  ticket type on a paid event): Accept confirms at once under the Event lock
  (capacity and ticket-type limit checked) with the normal ticket email.
- **Paid place**: "Accept and pay" holds the place for a day through the
  payment-link path (`offerInTransaction` for a solo order; the PER_TEAM
  leader's order holds the team's unit, team PENDING_PAYMENT and the leader's
  registration held; members, who have no order, stay pending). The settled
  payment confirms the place (`placePaidTeamOrder` confirms every member).
  **A place is never confirmed unpaid**: the database refuses CONFIRMED or
  PENDING_PAYMENT on an application's registration (or team) unless the
  application is OFFERED or ACCEPTED (`admission_status_guard`), and a
  confirmed registration accepts its offer (`admission_accept_on_confirm`).
- A hold that ends unpaid: the beat puts the order back to REQUESTED and the
  registrations to pending while `respondBy` is in the future (the offer
  stands); after it, the application EXPIRES and the order is CANCELLED. An
  applying team is never deleted with its expired hold.
- Decline (OFFERED) and withdraw (IN_REVIEW, WAITLISTED, OFFERED) close the
  application, cancel an unpaid order and offer the freed place onwards. Both
  are refused while a payment hold is live. An accepted applicant cancels
  their ticket instead.
- Organisers can extend an offer (later, before the start, at most 30 days
  at a time); the applicant is emailed.
- Offers being paid count as OFFERED against the offer capacity, and a live
  hold keeps its seat from other acceptances.

## Waitlist

WAITLISTED applications are offered free offers first in, first offered
(`queuedAt`, then id) by `promoteWaitlisted`: after a decline, withdrawal or
expiry, and every minute from the beat. An application that can't take a
place now (its ticket type is full counting places and open offers, or its
team is below the minimum size) is passed over with `skipReason` and keeps
its place. The older waitlist paths (`offerNextWaitlisted`,
`promoteOldestWaitlistedUnit`, `fillWaitlists`) never touch admission events.

## Old paths refused

`approveRsvp`, `rejectRsvp`, `promoteFromWaitlist`, `reacceptRsvp`
(`loadRsvpContext`), `approveTeam`/`rejectTeam`/`promoteTeam` and
`offerNextWaitlisted` refuse application registrations, so review coverage
and the offer capacity can't be bypassed; the database guard above backs
this up.

## Emails

One outbox kind, `admission-notice` (lib/outbox/admission.ts), one message
per person of the application: offer, reminder (once, a day before the
offer ends, by the beat), extended, expired, waitlisted, rejected, and
stage-advanced. The payload carries ids and the decision revision only; the
ticket link is added at send time, and a notice is dropped when the
application moved on. `stage-advanced` is queued only when the organiser
turned `emailApplicantsOnStageAdvance` on; every other notice always goes
out (each carries a decision or a deadline). Accepting a free place sends
the usual `rsvp-status` ticket email; paid places get the payment emails.
The registration email says "Application received" on these events.

## Webhook and API

- `application.status_changed` (`docs/WEBHOOKS.md`): event reference,
  application id, the solo or leader registration id, team id, status and
  current stage (id, position, name), previous status. Never answers,
  scores, reviews or reviewers. A trigger records every status or stage
  change in `AdmissionStatusEvent`, whatever made it (a release, an answer, a
  settled payment, a deleted registration); after each commit and from the
  beat those rows are claimed once each and sent (`drainApplicationEvents`).
- `GET /api/v1/events/:eventId/applications` (`applications:read`,
  `docs/API.md`): counts by status and stage and the offers out. Numbers only.

## Beat

`runAdmissionMaintenance` (`admission` job, every minute; safe to run twice):
ended holds and expired offers, reminders, AUTO decisions, waitlist offers.

## Not ported from Space Works

Staged forms, the code-of-conduct revision tables, date-change review,
team cohort sealing with roster hashes (roster changes are allowed while a
team's application is open; an applicant with an offer can't join a team),
PII/KMS mixins, receipts and ports. Space Works charges after confirmation;
this port never confirms unpaid.
