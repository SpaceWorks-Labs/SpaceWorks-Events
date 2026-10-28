# Mentor Desk

The Mentor Desk helps hackathon teams get help from mentors during an event:
a help queue with lease-based claims, mentor–team assignments, office hours
and mentoring rounds (stages of team check-in visits). It is ported from the
Space Works platform design (the SpaceWorks repository, `dev`, commits
`27b89c6e` and `4c53baa9`, `backend/apps/events/mentoring/`), with the
Django-platform parts left out (see [Not ported](#not-ported)).

It is **off by default**. Owners and admins turn it on in the event
dashboard's **Settings → Mentor Desk** (`Event.mentorDeskEnabled`); the
**Mentors** tab then appears. One-off events only. Turning it off removes
access everywhere (actions, the console, participant pages, the public
Mentors section, the judging conflict rule); nothing is deleted, and the
expiry beat keeps closing out requests.

Code: pure rules in `lib/mentorDesk/` (`rules.ts`, `allocation.ts`,
`roundForm.ts`); commands and read models in `lib/core/mentorDesk/`; Server
Actions in `app/actions/mentor-desk.ts` (organisers),
`app/actions/mentor-console.ts` (mentors) and `app/actions/mentor-help.ts`
(participants), gated by `app/actions/mentorDesk/gates.ts`.

## Who can do what

| Who | How they are proved | What they get |
| --- | --- | --- |
| Organisation OWNER/ADMIN | `resolveDeskOrganiser` (`getMembership`, staff MFA) | Everything: settings, mentors' profiles and conflicts, the queue (assign, release, resolve, reopen), assignments, office hours, categories, rounds and pools, the shortlist, the CSV (`canManageMentorDesk`) |
| Mentor | An `EventCollaborator` grant with `MENTOR` (invited from Settings → Co-organisers), the staff authenticator check (`staffMfaSatisfied`), and a `MentorProfile` (`resolveMentorContext`) | The mentor console: my queue, my claim, my teams, my office hours, the live round's visits, my profile and declared conflicts (`canMentor`) |
| Participant | The team's management link (`/team/:token`), or the signed-in owner of a CONFIRMED registration (`resolveParticipantForUser`) | Get help (raise, follow, comment, cancel, rate), the listed mentors, and for teams office-hour booking. A ticket link alone never raises help |
| Public | — | The event page's **Mentors** section: mentors who opted in (`showOnPage`), with name, bio and skills only |

`MENTOR` is isolated exactly like `JUDGE`: no other permission check accepts
it (`canAccessEvent` matches the exact grant), and a non-member whose grants
are `MENTOR` (and possibly `JUDGE`) is *mentor-only* (`isMentorOnly`): the
event page shows the mentor console (and the judging workspace for `JUDGE`)
and nothing else. A series grant can never carry `MENTOR`. Mentors are staff,
so they must use an authenticator app and pass the check each session
(owner decision). Mentors never pay: a `MENTOR` grant never creates an order
or a registration.

**Live eligibility.** Every mentor command re-reads, inside its transaction,
the `MENTOR` grant and the profile (`liveMentor`). Queue and visit commands
also require the mentor to be inside one of their availability windows:
outside them they are *off shift* ("You are outside your mentoring
availability."). An empty availability list means off duty. Profile edits,
declared conflicts and nominations work off shift.

**Grant lifecycle.** Accepting a `MENTOR` invite creates the profile
(`syncMentorGrantLocked`, `lib/core/mentorDesk/grant.ts`). Removing the grant
(a permission change or revoking the collaborator) ends the mentor's live
assignments, returns their claims to the queue (activity `role_ended`),
cancels their future office-hour slots (logged as `role_withdrawn`) and those
slots' bookings (the teams and the mentor get `office-hour-cancelled`), ends
their visit leases, and removes them from round pools, except a pool where
they are the only member: deleting that row would open the round to every
mentor, so it stays, inert without the grant.

**Crew ticket** (Settings → Mentor Desk → *Give mentors a crew ticket*,
`Event.mentorsGetCrewTicket`, off by default). After a `MENTOR` grant commits,
`syncMentorCrewAfterGrant` (`lib/core/mentorDesk/crewLink.ts`) adds the mentor
to the [event crew](CREW.md) through the crew core: role "Mentor", not listed
publicly, a free crew ticket with no order. The place is recorded on
`MentorProfile.crewMemberId`; removing the grant removes that place and only
that one. Someone already registered for the event keeps their own ticket and
gets no crew place. Mentors invited before the switch was turned on are not
changed.

**Reimbursements.** Like any co-organiser grant, a mentor-only grant passes
`canViewEventDashboard` for its own event, so the server accepts a staff
expense claim from a mentor for that event only ([Event finance](FINANCE.md));
the console does not show the claim form yet.

## Mentor profiles

`MentorProfile` per event and mentor: up to 8 skills (lowercased), a bio
(600), a **private** affiliation (200; organisers and the mentor only),
availability windows (UTC, entered in the event's timezone, inside the event),
`maxActiveTeams` 1–100 (CHECK) and `showOnPage`. Capacity cannot drop below
the mentor's live assignments; availability cannot drop a booked future
office hour ("Reschedule booked office hours before changing availability.").

## Help queue

**Categories** (`HelpCategory`, organisers): a fixed key, label, skill tags,
priority 0–100, open limit per team 1–10, claim minutes 1–60 and expiry
minutes 15–10080 (CHECK `HelpCategory_policy_bounds`), an optional note to
teams, and an active switch.

**Requests** (`HelpRequest`) come from a team or a solo registration (CHECK:
exactly one), raised by the participant (origin `TEAM`), by a mentor on a
team's behalf (`MENTOR`, the mentor must be eligible), or by a round trigger
(`ROUND`). Summary 1–1000 characters, location up to 120. A team holds at most
`openLimit` OPEN/CLAIMED requests per category (counted under the team row
lock). `expiresAt` = min(now + expiry minutes, event end); the **deadline** is
min(expiresAt, event end) and is checked inside every command.

States: `OPEN → CLAIMED → RESOLVED`, or `CANCELLED` (the team) or `EXPIRED`.
`HelpRequest.claimedByUserId` is `ON DELETE NO ACTION`: an account cannot be
deleted while it holds a claim (at most an hour, the longest claim); once the
claim ends or lapses the deletion goes through.

| Command | Who | Rules |
| --- | --- | --- |
| claim | Mentor, on shift | OPEN; eligible (below); not holding another live claim ("Finish or release the current request first."); the mentor's lapsed claims are released first |
| assign | Organiser | OPEN or CLAIMED (also on a lapsed lease); the target mentor is live, on shift, eligible, not busy |
| renew | The claiming mentor | Same claim id and generation; still eligible; lease = min(now + claim minutes, deadline) |
| release | The claiming mentor, or an organiser (also on a lapsed lease) | CLAIMED → OPEN, a new open generation |
| resolve | The claiming mentor or an organiser | CLAIMED → RESOLVED |
| reopen | Organiser | RESOLVED → OPEN, with a reason, within the team's open limit; the assigned-mentor window starts again |
| cancel | The team | OPEN or CLAIMED (also on a lapsed lease) → CANCELLED, before the deadline |
| comment | The team, or the claiming mentor | OPEN or CLAIMED, before the deadline; 1–2000 characters; never extends the deadline |
| rate | The team | RESOLVED, once, 1–5 |

A claim is a **lease**: `claimId` (UUID), `claimGeneration` and
`claimExpiresAt` (CHECK `HelpRequest_claim_shape`). A mentor holds at most one
claim per event (partial unique index `HelpRequest_one_claim_per_mentor`); two
mentors claiming at once are serialised by the row lock, and the loser gets a
version refusal. Every command checks `expectedVersion`. A lapsed claim is
refused as "This help claim expired. Refresh the queue."

**Eligibility** (`visitEligible`): never for the mentor's own team (or own
solo registration), never with an active declared/affiliation conflict. An
assigned mentor (an ACTIVE event-wide assignment, or one for the live round)
always qualifies; while an assigned mentor's priority window is open (5
minutes after raising or reopening) others wait; otherwise a category with
skill tags needs a mentor with one of them.

**Reads never mutate.** The board shows a lapsed claim as lapsed. The
`help-queue-expiry` beat job (`lib/core/mentorDesk/helpExpiry.ts`, every
minute, at most 100 rows per run, `FOR UPDATE SKIP LOCKED`, the action
re-derived from the locked row) returns lapsed claims to OPEN (activity
`lease_expired`, `openGeneration + 1`) and expires requests past their
deadline (`expired`). It is safe to run twice or from two processes, and runs
whether or not the desk is on.

**History.** `HelpRequestActivity` and `HelpRequestComment` are append-only
(trigger `mentor_desk_append_only`): updates may only clear a deleted
account's id; rows go only with their request.

**Privacy.** Help text and comments are shown only to the team, mentors and
organisers. They never reach webhooks, chat notifications, the outbox or
audit metadata; audit events (`MENTOR_HELP_ASSIGNED`, `MENTOR_HELP_REOPENED`)
carry ids only. The CSV leaves the text out.

## Mentor–team assignment

`MentorTeamAssignment` maps a mentor to a team, event-wide (`roundId` null)
or for one round. `PROPOSED → ACTIVE → ENDED` (CHECK: `endedAt` exactly with
ENDED); one live mapping per mentor, team and scope (partial unique index).
`activatedAt` is set when a mapping first becomes ACTIVE (CHECK: every ACTIVE
row has it); only activated mappings count as *mentored*, so a proposal that
was ended without being activated never creates a judging conflict or a
fresh-eyes exclusion.

Modes (`lib/mentorDesk/allocation.ts`, deterministic and pure):

- **MANUAL**: the organiser's pick per team.
- **ROUND_ROBIN**: lowest load first, then id.
- **SKILL_MATCH**: highest skill overlap (team skills: its members'
  "looking for a team" skills and the skill tags of the help it asked for),
  then lowest load, then id.
- **RANDOM** (a Space Works Events extension): a crypto-random seed, a
  seeded shuffle (sfc32 over a stably sorted input), then lowest load. The
  same seed always gives the same result; **Re-roll** previews with a new
  seed.

Every mode skips team members, declared/affiliation conflicts, existing live
mappings in the scope and full mentors (`maxActiveTeams`, counting event-wide
mappings and the scope's). **Preview writes nothing** and shows the seed and
an inputs fingerprint (SHA-256). **Apply** re-reads everything under the event
lock, refuses if the fingerprint changed ("The mentors or teams changed;
refresh the preview."), and records an append-only `MentorAssignmentRun`
(mode, seed, fingerprint, decisions, uncovered teams). Activating a proposed
mapping rechecks conflicts and capacity. Organisers can then **assign by
hand** (`manualOverride`, audited `MENTOR_ASSIGNMENT_OVERRIDDEN`). Mentors get
one `mentor-assigned` email per new active mapping.

**Per-stage pools** (Space Works Events extension): each round may name its
own mentors (`MentoringRoundMentor`; none means every mentor, and the UI says
so). Visits, and assignment within the round, use only that pool; queue
priority uses event-wide assignments plus the live round's.

**Fresh eyes across stages** (Space Works Events extension, per round): when
on, a mentor is never assigned to a team they mentored or visited in an
earlier round; when off, SKILL_MATCH and RANDOM avoid it where possible.

## Conflicts

`MentorConflict`: `DECLARED` (by the mentor, or an organiser) or
`AFFILIATION` (organisers), one live row per kind (partial unique index).
`createdByUserId` records who set it: a mentor declares and clears only their
own; one an organiser recorded is changed only by an organiser. Changes lock
the live row and check its version (0 for a new conflict).
Team membership always conflicts and is never overridable.

**Judging.** When the desk is on, `mentorJudgingConflicts(client, eventId,
userIds)` (`lib/core/mentorDesk/eligibility.ts`) returns the teams each user
mentored (an activated assignment, event-wide or in any round) or holds an
active conflict with. A mentored team is a conflict in every judging round. It feeds judging's single conflict rule, `conflictKeysFor`
(`lib/core/judging/judges.ts`), so those teams' projects are hidden from the
judge, refused for assignment and not counted in results. Desk off: no effect.

## Office hours

`OfficeHourSlot`: a mentor's slot inside the event and the mentor's
availability, no overlap with their other slots, capacity 1–50, booking
deadline before the start (CHECK `OfficeHourSlot_shape`). Mentors open their
own; organisers open, cancel and reschedule anyone's.

Booking (teams only: a team member signed in, or the management link) locks
the team, then the slot: open, before the start and the deadline; the mentor
still live and available for the whole slot and not conflicted; no
overlapping booking for the team ("Your team has an overlapping booking.");
the mentor not booked elsewhere at the time; capacity counted under the slot
lock ("This slot is full."); one live booking per slot and team (partial
unique index). A cancellation is a conditional update of a still-BOOKED row
under the slot lock, so concurrent cancels email once. A reschedule must start
in the future and keep every booked team free of overlaps and conflicts. Teams
cancel until the slot starts ("Ask an organiser to cancel
a started slot."); organisers cancel any time. Every reschedule or
cancellation is logged with a reason in the append-only `OfficeHourChange`.
The team's members and the mentor get `office-hour-booked` (with a calendar
invite, `lib/calendarInvite.ts`) and `office-hour-cancelled` emails.

## Mentoring rounds

Rounds are stages of team check-in visits, **never judging**.
`DRAFT → LIVE → CLOSED`, or `SKIPPED`; at most one LIVE round per event
(partial unique index `MentoringRound_one_live`); opening only inside its
window; closing ends every visit lease. While DRAFT, organisers set the
window (inside the event), the round's own form (up to 12 text, rating 1–5,
yes/no or choice questions; none can ask a date of birth or age), help
triggers, and whether revisits or declared conflicts may be overridden with a
reason.

A **visit** is a ten-minute heartbeat lease on a team (`MentoringVisit`,
generation-fenced; the console renews it every four minutes while the form is
open). Claiming refuses a team being visited, the mentor's own team,
**fresh eyes** (a team the mentor checked in before, in any round) and
declared/affiliation conflicts unless the round allows an override and the
mentor gives a reason. One **check-in** per team and round
(`MentoringCheckIn`, append-only), possibly *away*. Submitting refuses a
changed form ("The round form changed; review it again."). Answers can raise
follow-up help (`ROUND` origin, once per round and rule, skipped when the
category is full).

**Nominations** (`MentorNomination`, append-only) need a real (non-away)
visit, once per mentor, team and round. Organisers see them as a private
shortlist on the round; they never enter judging scores and never appear to
participants or the public.

**Took part.** `tookPartInRound(client, { eventId, roundId, teamId | rsvpId })`
and `teamsThatTookPartInRound` (`lib/core/mentorDesk/rounds.ts`): a team took
part when it has a non-away check-in in that round; a registration took part
when its team did. For later eligibility rules (e.g. per-stage reimbursements).

## Email

Transactional outbox kinds (`lib/outbox/mentor.ts`), ids only, rebuilt and
re-checked at send time (dropped when they no longer apply or the recipient no
longer belongs): `mentor-assigned`, `office-hour-booked`,
`office-hour-cancelled`, and the optional `help-claimed` (Settings switch,
`Event.mentorHelpClaimedEmail`; once per request, on its first claim). There
is no email per queue change.

## Surfaces

- **Settings → Mentor Desk**: the switch and the help-claimed email.
- **Mentors tab** (`?tab=mentors`): Queue (live board, refreshed every 15
  seconds), Mentors (profiles, shifts, conflicts), Assignments (scope, mode,
  preview with seed and re-roll, apply or propose, live mappings, hand edits,
  recent runs), Office hours, Categories, Rounds (form, triggers, pool,
  open/close/skip, shortlist), CSV; plus **My console** for an organiser who
  also mentors.
- **Mentor console** (mentor-only collaborators see only this): My queue, My
  teams (and declared conflicts), My office hours, Round visits, Profile.
- **Team page** (`/team/:token`): Get help, Mentors and office hours.
- **Account** (`/account/mentoring/:eventId`): the same for a signed-in
  confirmed registrant; the ticket page links to it (or to sign-in).
- **Event page**: the Mentors section for listed mentors.
- **CSV** (`/api/exports/events/:eventId/mentor-desk?view=requests|assignments`):
  owners and admins only, formula-neutralised, no help text or contact
  details, audited `MENTOR_DESK_EXPORTED`.

## Not ported

From the Space Works design, deliberately left out: makerspace tenancy and
module locks (the organisation is the tenant here), PII field encryption,
the programme lock contract and lane ports, staff grant presets, inert
imported roles and XLSX/CSV imports, practice runs, the notification-intent
table and attention/mute preferences (email is queued directly; queue changes
are polled), low-n diagnostics, codes of conduct and waivers, sponsor reps,
and contributor admissions (crew replaces them). Round "prior notes" from
earlier visits are not shown to other mentors.

## Tests

- Unit: `tests/unit/mentor-desk-rules.test.ts` (deadline, lease and expiry
  math, windows, eligibility, every allocation mode, seeded RANDOM
  determinism and variation, conflicts and capacity, soft fresh eyes, round
  forms and triggers); `event-capabilities`, `outbox-worker`.
- PostgreSQL: `mentor-desk-help` (open limit, simultaneous claims, one claim
  per mentor, lease fencing, off shift, priority window, skills and
  conflicts, lifecycle and audit privacy, deadline and expiry idempotence,
  append-only ledgers), `mentor-desk-assignments` (preview writes nothing,
  seeded RANDOM, stale fingerprints, capacity, hand edits, per-round pools,
  fresh eyes across stages, judging conflicts), `mentor-desk-office-rounds`
  (concurrent bookings and capacity, team overlap, logged reschedules, no
  cancel after start, one live round, visit leases, fresh eyes, away
  check-ins, nominations privacy, triggers, took part), and
  `mentor-desk-permissions` (MENTOR isolation, staff MFA, tenancy,
  participant proof, grant lifecycle).
