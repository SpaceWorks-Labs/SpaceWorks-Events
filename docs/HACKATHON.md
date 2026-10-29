# Hackathon submissions, judging, and results

[Documentation index](README.md)

Builds on [team registration](TEAMS.md). This page is the design contract;
[Features](FEATURES.md) summarises the shipped behaviour.

## Scope

- One-off events in either registration mode. An **entrant** is a team (in
  `TEAM` mode) or a single RSVP (a solo registrant, or anyone in an
  `INDIVIDUAL` event).
- Only `CONFIRMED` entrants can submit. A declined (`REJECTED`) team or
  registration is final: its project can't be saved, submitted or withdrawn,
  matching the team-side refusals, and the entrant page says it was declined.
- The machine API is out of scope; no DTO changes.

## Event settings (organiser, new **Judging** dashboard tab)

| Field | Meaning |
| --- | --- |
| `submissionsEnabled` | Turns the feature on for the event (submission form, judging, results, gallery). It can't be turned off once judging has started or results are published; closing the window is how organisers stop new projects. |
| `submissionsOpenAt`, `submissionsCloseAt` | Window, shown in the event timezone. Edits are refused outside it (server time, checked in the write transaction). |
| `judgingStatus` | `NOT_STARTED`, `OPEN`, `CLOSED`. Judges can only score while `OPEN`. Closing freezes scores. |
| `projectGalleryPublic` | After the window closes, show submitted projects at `/{orgSlug}/{eventSlug}/projects`. |
| `resultsPublishedAt` | Set when the organiser publishes results; clearing it unpublishes. |
| `resultsAnnouncedAt` | Set whenever entrants are emailed the results: the publication time when publishing with the switch on, or the send time with **Send results email now**. A value older than `resultsPublishedAt` belongs to an earlier publication, so the current one is not yet announced; see Results. |
| `emailEntrantsOnResults` | **Email entrants when results are published.** Off by default. See [Hackathon emails](#hackathon-emails). |
| `emailSubmissionReceipts` | **Email a receipt when a project is submitted.** Off by default. |
| `reviewsPerProject` | Target judges per project (1 to 20, CHECK constraint; null uses the default of 3). Drives Judging → Progress and is the automatic assignment default; applying an automatic assignment stores its number here. |

Settings changes, disqualification, closing judging, publishing or
unpublishing results, and sending the results email write audit events.

## Hackathon emails

Judging → Setup has a **Hackathon emails** section
(`components/event-dashboard/panels/JudgingEmailToggles.tsx`) with two
switches, both **off by default** on new and existing events (migration
`20261109000000_hackathon_email_toggles`, `NOT NULL DEFAULT false`). They are
saved with the other judging settings (`saveJudgingSettings` →
`updateJudgingSettings`, owners and admins only, so co-organisers can't change
them whatever their grants; a caller that leaves them out, such as the
Settings tab card, keeps their saved values), and `JUDGING_SETTINGS_UPDATED`
records both values and which changed. Cloning an event copies them. The
rules live in `lib/hackathonEmails.ts` and are enforced on the server where
the outbox rows are queued, reading the switch inside the same transaction,
never only in the UI:

| Switch | Gates | When off |
| --- | --- | --- |
| Email entrants when results are published (`emailEntrantsOnResults`) | `results-published`, and `finalists-announced` ([Rounds](#rounds)) | Publishing still works and records `resultsPublishedAt`, but queues nothing and leaves `resultsAnnouncedAt` as it was (unset, or older than the publication). Publishing a round's finalists likewise emails nobody. |
| Email a receipt when a project is submitted (`emailSubmissionReceipts`) | `submission-received` | Submitting queues no receipt, and neither does a project submitted once its entry fee is paid (`confirmEntryFeeTx`). Read under the Event lock in the submit transaction, and in the payment transaction on the entry-fee path. The entrant's confirmation mentions an emailed receipt only when one was queued. |

Everything else is registration, capability or money email and **always**
goes out, with no switch: `rsvp-confirmation`, `rsvp-status`,
`team-created`, `team-member-added`, `submission-link` (a solo entrant's only
way into the form), email verification, password reset, invitations,
broadcasts, and every payment email (the entry fee's *paid*, a late capture's
refund, and the refund when a disqualified project's fee is returned). Prize
payouts are recorded by hand and notify chat channels only, unchanged.

**Send results email now.** When results were published with the switch off,
the organiser turns it on and saves; the Results tab then shows **Send results
email now…** (offered while the current publication is not announced:
`resultsAnnouncedAt` unset or older than `resultsPublishedAt`), whose
confirmation gives the number of entrants and a note that a long list can run
into the mail provider's sending limits. `sendResultsAnnouncement`
(`lib/core/judging/announcement.ts` and the Server Action in
`app/actions/judging-admin.ts`, owners and admins like publishing, broadcast
rate-limit bucket) requires published results and the switch on; under the
Event row lock it sets `resultsAnnouncedAt` and queues the same
one-email-per-confirmed-entrant-address announcement as publishing, skipping
every address that already holds an announcement row for the event, so two
concurrent calls send once and a later call is a no-op. Audited
`JUDGING_RESULTS_ANNOUNCED` (recipient count and whether an earlier
publication was announced).

The Results tab says what will happen before publishing ("Publishing won't
email entrants…" or "Publishing emails every confirmed entrant…"), and the
publish confirmation says "Results will be published without emailing
entrants." or "N entrants will be emailed." The count comes from
`countResultsAnnouncementRecipients` (one SQL count with the same rules as the
send). It only runs when a dialog will show it (switch on and the current
publication not announced), because it scans the outbox. When an earlier
publication was announced, a count of zero is explained as "everyone … was
already emailed the results". After publication the card says whether
entrants were emailed.

Unpublish and republish keep the no-duplicate rules below. With the switch
off, a republication emails nobody. If an earlier announcement was partly
delivered before the unpublish withdrew the rest, the card says that anyone
whose email was withdrawn hasn't been told, and once the switch is on **Send
results email now** emails exactly those entrants (and any newly confirmed
ones), never anyone who already holds an announcement for the event.

Entrants only reach the submission form on a live event (`PUBLISHED`, website
released). Submissions can be switched on while the event is a draft, so the
settings card shows a warning whenever the switch is on and the event is a
draft, offline (`HIDDEN`), or cancelled, and the save toast repeats it. On a
draft or offline event an entrant's ticket shows "Your project" with a line
saying submissions open once the event is published (or are unavailable while
it is offline) instead of a form; the submission pages themselves stay 404.

## Submissions

`Submission`: `eventId`; exactly one of `teamId` (unique) or `rsvpId` (unique),
enforced by a CHECK constraint; `title` (up to 120), `summary` (up to 4000,
plain text), `repoUrl`, `demoUrl`, `videoUrl` (optional, `https:` only, up to
500 characters, validated with `URL`); `status` `DRAFT`, `SUBMITTED`,
`WITHDRAWN`, `DISQUALIFIED`; `submittedAt`; `disqualifiedReason` (organiser-only);
timestamps.

Who may edit an entrant's submission (always re-scoped by event):

- **Team:** the leader via the team page (`/team/{manageToken}`), or any
  signed-in user who owns a member RSVP of that team.
- **Solo:** the signed-in owner of the RSVP, or the holder of a **submission
  link** `/submit/{token}`. A solo registrant requests that link from their
  ticket page; it is emailed to the RSVP's address through the outbox (so
  possessing the ticket QR alone is never enough). The token is random, at
  least 128 bits, stored as a SHA-256 hash on the RSVP-scoped row, and
  regenerating it retires the old one. When the registration changes hands
  (a ticket transfer, or an organiser changing the guest's email) the link
  is deleted in the same transaction (`lib/rsvpHolder.ts`): the project stays
  with the registration, and the new holder requests a new link.

Entrants can save a draft, submit, edit while the window is open, and withdraw.
Published results freeze every project, even while the window is still open:
saving, submitting and withdrawing are refused ("Results are published, so
projects can no longer change.") and the editor is read-only
(`resultsFreezeSubmissions` in lib/core/judging/shared.ts, read under the
Event lock that publishing takes for update). Unpublishing lifts the freeze.
An entry fee whose payment arrives after publication is kept and its order
confirmed, but the waiting draft is not submitted (`confirmEntryFeeTx`,
lib/payments/entryFees.ts); the organiser decides what to do with it.
The editor's window line says when submissions open or close, that they are
closed, or, if the dates are missing, that the organisers haven't set them.
A team that is disbanded or a solo RSVP that is cancelled has its submission
deleted with it (cascade). An organiser's deletion of a team or registration
keeps the submission and its judging record (scores, reviews, assignments,
award places) in the undo snapshot, so undo restores them too.

An entrant is a team or a single RSVP, never both. When a solo registration
joins a team (accepting a join request or invitation, joining with a pasted
team link from the ticket or join page, or an organiser move), in the same
transaction (`moveSoloRsvpIntoTeamTx` and `organiserMoveMember` in
`lib/core/teams.ts`, both calling `retireSoloSubmissionForTeamTx` after every
other check, inside `teamTransaction` so the registration webhooks are sent
only after commit): a `SUBMITTED` solo project refuses the move until it
is withdrawn (or disqualified); a `DISQUALIFIED` one refuses a join from the
entrant side and is deleted by an organiser move; a `DRAFT` or `WITHDRAWN`
one is deleted. The solo submission link is retired. When receipts are on
(`emailSubmissionReceipts`), the `submission-received` email goes to the
person who submitted. Organisers can disqualify (with a reason the entrant does not
see) and reinstate. Disqualifying removes the project's award places; the
dialog lists the awards it holds and, once results are published, warns that
the live results page changes straight away. Reinstating asks first and says
that lost awards are not given back (reassign them on the Awards tab).

## Judges

- New `EventPermission` value `JUDGE`, granted through the existing event
  collaborator invitation flow. A collaborator with only `JUDGE` sees only the
  judging workspace: no guest list, answers, emails, check-in, or event
  editing. Org owners and admins can also judge. `JUDGE` never satisfies any
  other check: `canAccessEvent` matches exact grants, so
  `canManageRegistrationsFor` (guest actions, team admin, attendee CSV),
  custom check-in lists (`CHECK_IN`/`EDIT_DETAILS`), email drafts and
  broadcasts (admin), and webhooks (admin) all refuse a judge-only
  collaborator, and `eventCapabilities` (`canJudge`, `isJudgeOnly`) shows such
  a viewer only the judging workspace. See [Permissions](PERMISSIONS.md).
- Judges are organisation staff: a `JUDGE` collaborator, like an owner or
  admin, must pass the staff authenticator check this session
  (`lib/staffMfa.ts`) before `resolveJudgeContext` grants anything, and the
  cores' own re-check (`isEligibleJudge`) fails closed the same way for the
  person acting, so a judging context resolved earlier stops working too.
- **Managing judging is owner/admin only.** Settings, the rubric, judge
  assignments, disqualification and reinstatement, awards, results
  publication, and the scores CSV (`canManageJudging`, `resolveJudgingOrganiser`)
  need an organisation OWNER or ADMIN. No grant reaches them, not even
  `MANAGE_REGISTRATIONS`: judging decides the competition's outcome, which is
  not registration management, and a co-organiser who runs the guest list
  should not be able to rewrite the rubric or publish winners. A future
  dedicated grant could delegate it.
- Organisers choose **All judges see all submissions** or assign specific
  submissions to specific judges (`JudgeAssignment`).
- **Recusal** (as Space Works judging has it): a judge assigned to a project
  in the open round can **Recuse myself** from it on the scoring view (web)
  or `POST …/judging/submissions/:submissionId/recusal` (mobile), until
  their review of it is submitted (then it is the organisers' call). The
  assignment stays with `recusedAt` set: the project leaves the judge's list,
  scoring and "Score next" in that round, manual and automatic assignment
  never give it back to them (an automatic run leaves recused rows alone and
  treats the pair as blocked), and it counts like a missing review in
  Progress, whose Judges list shows each judge's recusals. The judge sees a
  **Recused** list with **Undo** while the round is open (`DELETE` on the
  same mobile path). Removing the assignment clears the recusal with it.
  Audited (`JUDGE_RECUSED`, `JUDGE_RECUSAL_WITHDRAWN`).
- The **Judges** tab lists **Invited judges** (`JUDGE` grants; its count is
  theirs alone) with an empty state linking to Settings, then **Organisers who
  can also judge** (owners and admins). Inside the Judging tab, the **Score**
  view speaks to organisers as organisers: an empty rubric links to the rubric
  editor on Setup, and "not started" says to open judging there.
- **Conflict of interest:** a judge whose own account owns an RSVP on that
  entrant is never shown that submission and cannot score it (checked
  server-side).
  With the [Mentor Desk](MENTOR_DESK.md) on, a judge who mentored a team (an
  active or ended mentor assignment, in any round) or holds a mentor conflict
  with it is conflicted the same way: the single rule `conflictKeysFor`
  (`lib/core/judging/judges.ts`) adds `mentorJudgingConflicts`. Mentors'
  round nominations are a private organiser shortlist and never enter scores.
- Judges see the submission content (title, summary, links, team name). They
  never see entrant emails, answers, or ticket links.
- The **Score** list is paged on the server: 25 at a time with **Load more**
  (keyset cursor on `submittedAt, id`), filters **All**, **To score** (no
  submitted review yet), **In progress** and **Reviewed**, and a search on
  project title, team name, or a solo entrant's first name (the surname is
  never shown, so it is never matched). Visibility (status, assignment,
  conflict of interest) is applied in the same query, and the progress totals
  come from separate counts over everything the judge may see.
  `loadJudgeSubmissionsPage` re-resolves the judge on every call.
- **Score next project** (`nextSubmissionForJudge`,
  `loadNextJudgeSubmission`): while judging is `OPEN`, the server picks, among
  the projects this judge may score (same visibility query as the list) that
  they have not submitted a review for, one they already started (saved
  scores or a draft comment) first, then the fewest submitted reviews from
  anyone, then the oldest `submittedAt`, then `id`, and loads it like any
  opened project. After a judge submits a fresh review, the next project
  opens on its own with a toast ("Next up: …", with **Back to list**); the
  **All submissions** button also returns to the list. When nothing is left,
  the list shows a "You're all caught up" state. Focus moves to the project
  heading (or the done heading).
- The public gallery shows 24 projects per page with page numbers in the URL
  (`?page=N`, clamped to the last page by redirect) and an optional `?q=`
  search on the same fields (trimmed, whitespace collapsed, at most 100
  characters, ILIKE with `%`, `_` and `\` matched literally). Orders
  (`?sort=`): **Newest** (default, `submittedAt DESC, id DESC`), **A–Z**
  (`lower(title), title, id`) and, once results are published, **Awards
  first** (each project's best award by award position, creation and id as
  on the results page, then place; then everyone else A–Z, then `id`). Once
  results are published, `?filter=winners` (**Award winners**, with its own
  count) narrows to SUBMITTED projects holding an `EventAwardWinner` of the
  same event, and each card shows award badges (award name and place only).
  Before publication `winners` and `awards` fall back to the defaults and no
  badges are loaded, so the gallery never reveals winners early; any other
  invalid value falls back too. Search, filter and order run in SQL
  (`lib/galleryQuery.ts`, params in `lib/judgingPaging.ts`), counts come from
  separate queries under the same conditions, and the controls are a GET
  form (`next/form`) plus plain links, so every view is a shareable URL and
  works without JavaScript; the count is announced in a polite live region.
  Each plain page is its own canonical URL; searched, filtered and re-sorted
  views point their canonical at the plain gallery (no filter params) and are
  not indexed. The public results page is bounded by the award limits
  (`EVENT_AWARDS_LIMIT` awards, places up to `EVENT_AWARD_PLACE_MAX`); once it
  lists more than 10 winners it offers the same `?q=` search, matched on the
  shown project title and entrant name, dropping awards without a match.

## Automatic assignment

Judging → Progress → **Assign judges automatically** (owners and admins,
`canManageJudging`; cores in `lib/core/judgingOps.ts`, the pure algorithm in
`lib/judgingAssignment.ts`).

- **Who judges (the pool).** The organiser ticks the judges to draw from.
  Every `JUDGE` collaborator is ticked by default; organisation owners and
  admins are listed apart and are in the pool only when ticked (they opt in
  per run). The server re-reads eligibility (a `JUDGE` grant on the event, or
  OWNER/ADMIN of the organisation) inside the transaction and refuses the
  whole run if anyone picked can no longer judge.
- **Judges per project** N (1 to 20, default `reviewsPerProject`, else 3).
- **Keep current assignments**: existing assignments stay and count towards N
  when their judge can still judge the event and has no conflict; only the
  gaps are filled. **Start over**: existing assignments on submitted projects
  are removed, except where that judge has already saved a score or a review
  for the project (kept and counted). An assignment the new plan would pick
  straight back is left in place rather than removed and re-added.
- **Work started without an assignment.** While judges see every project,
  they can score with no assignments at all. Applying switches judges to
  "assigned projects only", so in either mode every project a judge (in the
  pool or not) has already saved scores, a draft comment or a submitted
  review for becomes that judge's assignment, provided they can still judge
  and have no conflict. It counts towards N and towards the judge's load, so
  nobody loses access to their own work and finished projects aren't given
  extra judges. When judges already see assigned projects only, a submitted
  review without an assignment still counts towards N (it counts in Results)
  and its judge isn't picked for that project again.
- **Algorithm.** Every `SUBMITTED` project gets N judges from the pool. A
  judge is never given a project they have a conflict of interest with (the
  same rule as the judge's own list: their account owns an RSVP on that
  entrant). Projects with the fewest possible judges go first; for each, the
  judges are taken from a min-heap on current load (kept plus new
  assignments on submitted projects), ties broken by a 32-bit FNV-1a hash of
  judge id and project id, then judge id, so the same input always gives the
  same plan and a re-run with nothing changed plans no changes, in either
  mode. Projects that
  can't reach N (too few judges without a conflict) are reported.
- **Preview first.** Preview writes nothing and shows each judge's
  assignments now, the change, and the total after, the projects short of N
  (the first 50 and a count), how many started projects become assignments,
  and a warning when judges currently see every project. It returns a
  fingerprint of the plan.
- **Apply** takes the Event row lock (`FOR UPDATE`, scoped by organisation),
  re-plans, refuses if the plan's fingerprint differs from the preview
  ("changed since the preview"), then in one transaction removes and adds
  assignments (including the started projects above), sets `judgesSeeAll = false` (judges then see only their
  assigned projects) and `reviewsPerProject = N`, and writes
  `JUDGES_AUTO_ASSIGNED` (N, mode, counts only, including `adopted`). Refused while judging is
  `CLOSED` or results are published.

## Progress

Judging → **Progress** (owners and admins only; the Judging tab's sub-tab
`?sub=judging-progress`). Computed on the server over the event's submitted
projects, then shown as numbered pages of 25 per list
(`loadJudgingProgressPage`, re-checked as an organiser on every call, on the
`search` rate-limit bucket). A *counted* review is the same as in Results:
submitted, by someone who can still judge the event, with no conflict of
interest. Rules are pure functions in `lib/judgingProgress.ts`.

- **Summary**: projects at target, review coverage (counted reviews, each
  project capped at the target, over projects × target), outlier and stale
  counts, and the **Target judges per project** field (empty for the
  default; audited `JUDGING_REVIEW_TARGET_UPDATED`).
- **Projects below target**: counted reviews under the target, fewest first,
  with in-progress and assigned counts.
- **Judges**: every invited judge, and organisers once they have
  assignments, scores, or reviews. Assigned (or, when judges see all, every
  project they may see), started (scores saved, review unsubmitted),
  submitted, and completion (submitted reviews of those projects over their
  number, 0 to 100), lowest completion first. Projects a judge recused from
  leave their expected work and coverage, and the row says how many.
- **Outlier scores**: for a project with counted reviews from n ≥ 3 judges,
  a judge whose weighted percentage differs from the mean of the other
  judges' by more than 2 × the population standard deviation of all n; with
  n = 2, both judges when they are more than 25 points apart. Advisory only;
  nothing changes.
- **Stale reviews**: saved scores, review not submitted, last score saved
  more than 24 hours ago, oldest first.

## Rubric and scoring

- `JudgingCriterion`: name (up to 80), description (up to 500), `weight` 1 to 10,
  `maxScore` 1 to 10, `position`. The rubric can only be changed while
  `judgingStatus = NOT_STARTED`.
- `JudgeScore`: one row per submission, judge, and criterion (unique), integer
  `0..maxScore`. `JudgeReview`: one per submission and judge with a private
  comment (up to 2000, organisers only) and `submittedAt`. Judges can save
  partial scores and submit when every criterion is scored. Writes are refused
  unless `judgingStatus = OPEN` and the submission is `SUBMITTED`.
- **Result score** = the mean over counted judges (a submitted review, the
  judge can still judge the event, and no conflict of interest with that
  entrant now) of
  `Σ(weight × score / maxScore) / Σ weight × 100`, rounded to one decimal.
  Submissions with no submitted reviews have no score. Ties share a rank.
  This is the **raw** score.
- **Adjusted score** ("Adjust for harsh/generous judges",
  `Event.scoreNormalization` = `ZSCORE`; `RAW` by default). Per judge, over
  that judge's counted reviews of `SUBMITTED` projects, take the mean `m` and
  the population standard deviation `sd` of their judge scores (the 0..100
  weighted percentages above); each of their scores `x` becomes
  `clamp(50 + 15 × (x − m) / sd, 0, 100)`. A judge with fewer than 3 counted
  reviews, or with `sd = 0`, keeps raw scores. The adjusted score is the mean
  of those per-judge scores, rounded to one decimal. Revoked and conflicted
  judges are left out exactly as for raw scores, so they never shift anyone's
  scale. Both scores are always computed (pure functions in
  `lib/judgingScore.ts`); the event's method only picks which one ranks (the
  Results table, the Awards picker, the CSV's rank and result score). The
  switch is owner/admin only (`setScoreNormalization`, audited
  `JUDGING_SCORE_NORMALIZATION_CHANGED` with `from` and `to`) and can change
  at any time: ranks only guide manual award choices, and public pages never
  show scores or ranks.

## Rounds

Judging can run in stages (a Space Works addition to Yuyu's single-round
judging; the round workflow follows the Space Works platform design in
`backend/apps/events/judging`, and finalist advancement is new). Cores in
`lib/core/judging/rounds/` (entry `lib/core/judgingRounds.ts`), the pure
advancement plan in `lib/judgingAdvancement.ts`; actions in
`app/actions/judging-rounds.ts`; owners and admins only
(`resolveJudgingOrganiser`), every change under the organiser Event lock and
audited (`JUDGING_ROUND_CREATED`, `_UPDATED`, `_DELETED`,
`JUDGING_ROUNDS_REORDERED`, `JUDGING_ROUND_PANEL_UPDATED`,
`JUDGING_ROUND_FINALIZED`, `_UNFINALIZED`, `JUDGING_FINALISTS_ADVANCED`,
`JUDGING_FINALISTS_PUBLISHED`, `_UNPUBLISHED`, `JUDGE_ASSIGNED`,
`JUDGE_UNASSIGNED`; counts and ids only).

- **Model.** `JudgingRound` (`position` unique per event; `status` DRAFT, OPEN,
  CLOSED, at most one OPEN per event by a partial unique index;
  `reviewsPerProject`, `scoreNormalization`, `judgesSeeAll`, `freshEyes`,
  `entrySource` ALL_SUBMITTED or ADVANCED, planned `opensAt`/`closesAt`,
  `finalistsPublishedAt`, `finalizedAt` with an optional
  `finalizeExceptionReason`). Criteria, assignments and reviews belong to a
  round (`roundId`; the assignment and review uniques include it); scores
  follow their criterion. `JudgingRoundEntry` holds an ADVANCED round's
  finalists (`sourceRank`, who advanced them, when); `JudgingRoundJudge` a
  round's own panel; `JudgingAssignmentRun` each applied automatic
  assignment. Triggers keep every round row in its own event.
- **Single round, as before.** Every event starts with one round, "Main"
  (the migration backfilled it for events with judging data; the first
  rubric line, settings save or status change creates it). The **current
  round** is the latest round that has opened, else the first
  (`Event.currentJudgingRoundId`). For this release the event-level
  `judgingStatus` (DRAFT is `NOT_STARTED`), `judgesSeeAll`,
  `reviewsPerProject` and `scoreNormalization` mirror it, both ways (code
  keeps them in step; a trigger copies event-level writes onto the round),
  and a trigger fills a missing `roundId` with it. Every rule above
  (visibility, conflicts, scoring, Score next project, automatic assignment,
  Progress, Results, CSV, awards, publication, entry fees) runs unchanged on
  the current round, so an event with one round behaves exactly as before.
  The contract release makes `roundId` NOT NULL and drops the mirror.
  Events whose judging was already CLOSED before the upgrade get a CLOSED,
  not finalised, Main round: finalise it before advancing finalists from it.
- **Order and status.** Rounds open in order: a round opens only when every
  earlier round is CLOSED and no later round has opened, with a rubric, and
  (ADVANCED) with finalists. Closing freezes scores; reopening and resetting
  to DRAFT follow the rules above, and never once a later round has opened.
  The first round always judges every submitted project (CHECK). Only DRAFT
  rounds other than the first can be deleted (later ones move up); rounds
  that have opened or hold finalists keep their place when reordering.
- **Rubric per round.** Each round has its own criteria, weights and maximum
  scores, editable only while it is DRAFT (frozen once it opens).
- **Panels.** Organisers choose who judges each round. No panel (the
  default, said so in the UI) means everyone who can judge the event; with a
  panel only its members, who must still hold `JUDGE` or be owners or
  admins, see, score, are assigned or are counted in that round.
- **Fresh eyes** (optional, per round, fixed once the round opens): a judge
  neither sees nor is assigned a project they submitted a review for in an
  earlier round; a hard rule in visibility, manual and automatic assignment
  and Progress. Because it can't change mid-round, counted reviews, finalising
  coverage and the advancement ranking never need to re-apply it.
- **Automatic assignment per round** (the current round): **Balanced** as
  above, or **Random**: the server draws a 128-bit seed (shown with the
  preview; **Re-roll** previews with a new one) and breaks ties with
  SHA-256(seed, id) instead of the fixed hash, over the same sorted inputs,
  so a seed always gives the same plan while conflicts, fresh eyes, the
  target and even loads hold exactly as for Balanced. Apply needs the
  previewed seed and plan fingerprint and stores a `JudgingAssignmentRun`
  (strategy, mode, seed, target, counts, input and plan fingerprints).
  Manual assigning and unassigning afterwards are audited naming the round
  and the latest run.
- **Finalising** (from the Space Works design): a CLOSED round is finalised
  when every project it judges has the target number of counted reviews, or
  with a reason when some fall short (missing reviews are never counted as
  zero). A finalised round can't reopen, and its target and score method
  can't change; finalising can be undone until finalists have advanced. It
  is separate from publishing results. Finalising freezes which reviews count:
  the counted (project, judge) pairs are stored in `JudgingRoundCountedReview`
  (`JudgingRound.countedFrozenAt` marks it), and the round's Results table,
  CSV and finalist advancement read them from then on, so a judge grant
  revoked, a panel changed or a new conflict later never moves a finalised
  ranking (a project disqualified since still drops out). Undoing finalising
  clears the snapshot and the round counts live again. Rounds finalised
  before this snapshot existed keep counting live.
- **Advancing finalists** into an ADVANCED round from the round before it,
  once that round is closed and finalised: the top N scored projects of its
  ranking (the Results table's order; a tie at the cut is flagged) or a
  hand-picked list of its SUBMITTED projects. Preview writes nothing and
  returns a fingerprint of the choice, ranks and current finalists; Apply
  takes the Event lock, re-plans, and refuses a changed plan. Refused once
  the round opens (finalists are frozen) or while its finalists are
  published. Disqualified and withdrawn projects never advance, and one
  disqualified later simply drops out of the round.
- **Judges** see only an ADVANCED round's finalists (still SUBMITTED), under
  the round's own visibility, panel, fresh-eyes and conflict rules. A judge
  reviews a project again, separately, in each round.
- **Results, awards and prizes come from the final round.** Results,
  the Awards picker and the CSV rank the current round (the final one once
  it has opened); publishing results is refused while a later round is still
  DRAFT. When the final round judges advanced finalists, only its finalists
  can win an award (`lib/core/judging/rounds/awardEligibility.ts`): picking a
  winner checks it, advancing finalists into the final round removes award
  winners left out (the preview warns how many; audited in
  `JUDGING_FINALISTS_ADVANCED` as `awardWinnersRemoved`), publishing results
  is refused while any winner isn't a finalist, and the public results page
  and prize payouts apply the same rule. With more than one round, results
  are published only once the final round is finalised; a single-round event
  publishes from a closed round as before.
- **Judges' round switcher** offers the rounds that have opened and the
  current round, never a later DRAFT round (refused on the server too).
- **Publishing finalists** (separate from results) sets
  `finalistsPublishedAt`, shows a **Finalists** block on
  `/{org}/{event}/results` (titles, entrant display names and links,
  alphabetical; never scores or ranks; the page exists once either finalists
  or results are published, and is titled "Finalists" until results are). When **Email entrants when results are
  published** is on (`Event.emailEntrantsOnResults`, off by default; the
  single gate is `entrantJudgingEmailsEnabled`), it queues one transactional
  `finalists-announced` email per address of the finalists' confirmed
  entrant members, listing every finalist project of that person, once per
  round: each recipient is recorded in `JudgingFinalistNotice` (a SHA-256 of
  the address), which outlives the outbox row. Unpublishing withdraws
  undelivered emails and forgets those recipients, so republishing emails
  only them. Publishing with the switch off emails nobody. No webhook: the
  webhook catalogue has no judging events yet.
- **Entry fees** gate entry into round 1 exactly as before (only SUBMITTED
  projects are judged); later rounds never charge.
- **Dashboard.** Judging → **Rounds** lists the rounds (status pills with a
  word, current, finalists published) and the chosen round's settings,
  judges, rubric and finalists, with Edit, Choose judges, Open/Close/Reopen,
  Finalise, Advance finalists, Publish finalists and Delete. Score, Progress
  and Results get a **Round** switcher when there is more than one round;
  other rounds show read-only (the score method, target, automatic
  assignment and publishing act on the current round), and the Results
  export carries `round`.
- **Conflicts** are decided in one place, `conflictKeysFor`
  (`lib/core/judging/judges.ts`), which every path uses; the Mentor Desk adds
  mentored teams there.

## Results and awards

- `EventAward`: name (e.g. "Overall winner", "Best design"), description,
  `position`, plus `EventAwardWinner` (award, submission, `place` 1 or more,
  unique per award and place). Organisers assign winners manually, guided by
  the ranked score table. Only `SUBMITTED` submissions can win.
- Organiser **Results** view: ranked table (raw and adjusted scores, the
  active one marked "ranks", judges counted, per-criterion averages), the
  **Adjust for harsh/generous judges** switch, judging progress per judge, and
  CSV export of scores (`/api/exports/events/{eventId}/judging`, owners and
  admins only; columns *Result score* (the active method's), *Raw score* and
  *Adjusted score*). The CSV's
  review times are ISO 8601 in the event timezone with an explicit offset
  (`2026-10-25T14:30:00+05:30`), and the column header names the zone
  (`Review submitted (Asia/Kolkata)`). Until results are published, the
  publish card's hint follows the judging status: open judging first (not
  started), close judging to finalise the scores (open), or pick winners and
  publish (closed).
- **Organiser paging** (`lib/judgingOrganiserPaging.ts`): Submissions loads
  50 projects at a time, oldest first (keyset on `createdAt, id`), with "Load
  more". Its status filter and search (title, team name or registrant name)
  run on the server, and the chip and tab counts are per-status totals. The
  ranking is computed over every project, then Results shows numbered pages
  of 50, so a rank and a tie are the same on every page. A search filters the
  ranked rows without renumbering them. The Awards winner picker searches the
  ranked `SUBMITTED` projects on the server, 20 at a time. The Judges view
  takes its counts from aggregates.
- **Filtered exports**: Results **Export CSV** holds the ranked rows matching
  the search and score chip showing, ranked under the score method the table
  shows (`q`, `scored`, `method`), with ranks from the whole ranking.
  Submissions **Export CSV** (`view=submissions&status=&q=`) holds every
  project matching the chip and search: project, entrant, team or solo,
  status, submitted and updated times in the event timezone, summary, links,
  assigned judges' names and the disqualification reason; *Not submitted*
  exports the entrants instead. Both read their view's own query in batches of
  200 projects (`planJudgingResultsExport`, `planJudgingSubmissionsExport`),
  stay owner/admin only with an empty 404 for anyone else, and audit filter
  names only (`JUDGING_SCORES_EXPORTED`, `JUDGING_SUBMISSIONS_EXPORTED`).
- **Saved views** ([Features → Saved views](FEATURES.md#saved-views)):
  Submissions, Results and Progress keep their filters in the address bar
  and have a **Views** menu (owners and admins, like the rest of judging
  management). Submissions gains **Not submitted** (`status=notSubmitted`):
  instead of projects it lists *entrants* without a `SUBMITTED` project,
  meaning `CONFIRMED` teams and `CONFIRMED` registrations without a team,
  whose project is missing, a draft, withdrawn or disqualified
  (`lib/core/judgingEntrants.ts`, one `UNION ALL` query with keyset paging on
  registration time and id, display names and sizes only, through
  `loadUnsubmittedEntrantsPage`, `search` bucket), with its chip count.
  Results gains a score filter (`scored=unscored`: `SUBMITTED` with no counted
  review; `scored=underTwo`: fewer than two) that filters the ranked rows
  without renumbering them, with counts over the whole ranking. Progress
  can show one list (`show=below-target`, `judges`, `outliers`, `stale`).
  Presets: *Not submitted*, *Drafts*, *Disqualified*; *Unscored*, *Scored by
  fewer than 2 judges*; *Below target*.
- **Publishing results** sets `resultsPublishedAt`, shows
  `/{orgSlug}/{eventSlug}/results` (awards, winners' project titles, team or
  entrant display names, and links), and, only when
  `emailEntrantsOnResults` is on (see [Hackathon emails](#hackathon-emails)),
  queues one `results-published` email per confirmed entrant member (crew
  places are never emailed, and the recipient count leaves them out), once:
  unpublishing withdraws undelivered
  announcements (and, when none had been delivered, clears
  `resultsAnnouncedAt`), and a re-publication emails only addresses whose copy
  was withdrawn. Scores and judge comments are never public.
- Results, gallery, and submission pages follow exactly the same visibility,
  publication, and invite rules as the event page, and return a real 404
  otherwise. On the entrant's own submission pages the entrant proof (team
  link, own registration, or submission link) stands in for the invite list,
  as on the ticket and team pages; the publication rule still applies.

## Entry fees

- **Settings → Project entry fee** (`Event.submissionFeeMinor`, owners, admins
  and `EDIT_DETAILS` co-organisers, needs paid events and a connected payment
  account, audited `ENTRY_FEE_UPDATED`): a fee paid once per entrant when they
  submit a project, and whether it is refunded in full when the project is
  disqualified (`submissionFeeRefundOnDisqualify`, on by default).
- **Submit** with the fee unpaid saves the project as a draft and opens the
  organiser's checkout for an order with no registrations
  (`Order.submissionId`, one `FEE` line, a 30-minute hold;
  `lib/payments/entryFees.ts`). A live hold is reused. When the payment lands
  the order is confirmed and the project submitted (audited `ENTRY_FEE_PAID`;
  the *paid* email always, *submission received* only when receipts are on);
  a late payment is still accepted, since no
  places are held. Entry fees appear in the orders CSV and the Money
  reports like other orders.
- A project already paid for stays paid if it is withdrawn and submitted
  again; once its fee is refunded in full, submitting asks for it again. A
  payment that lands after the fee was paid on another order is refunded in
  full. Disqualifying refunds a paid fee in full when the setting is on;
  reinstating charges nothing, so a project whose fee was refunded can't be
  reinstated (it would stand submitted unpaid); a waived or kept fee can. Cancelling the event refunds fees with the
  tickets.

## Prize money

- An award can carry a **prize per winner** (`EventAward.prizeMinor`, in the
  event's currency). Judging → **Prizes** (organisation owners and admins
  only) sets it, lists each winner with what has been paid, and records
  payouts made by hand: who was paid, the amount (never more than the prize in
  total), cash / UPI / bank transfer / card terminal / other, a reference, the
  day and a note (`lib/prizes.ts`, audited `AWARD_PRIZE_UPDATED`,
  `PRIZE_PAYOUT_RECORDED`, `PRIZE_PAYOUT_REVERSED`, chat event *Payouts*).
- `PrizePayout` is an append-only ledger: a database trigger refuses any
  change except clearing a reference when the award, project, event or user is
  deleted (names are copied onto the row). A mistake is undone by a
  **reversal** row for the same amount and currency (`reversesId`, at most one
  per payout, checked by a second trigger); the original stays on record.
  Rows can't be deleted either, except with their organisation.

## Tests

- Integration (`tests/integration/judging.db.test.ts`): submissions refused
  outside the window, for non-confirmed entrants, and across events or
  organisations; a solo submission token cannot edit another entrant; a
  `JUDGE`-only collaborator cannot read guests or another event; conflict of
  interest; scores refused unless judging is open; concurrent score writes
  stay unique; the result-score formula and tie ranks; awards only for
  submitted entries; the results page hidden until published and for
  non-public events; a solo project never carried into a team; deletion undo
  restoring the project and its judging record; reviews by revoked or
  conflicted judges not counted; submissions locked on once judging starts;
  the results announcement sent once across re-publication; links stored in
  canonical `https://` form; joining a team by link applies the same solo
  project rules and still sends registration webhooks; one team undo snapshot
  restoring the project, judging record, and custom check-in list records,
  with older snapshot formats still restoring; a `JUDGE`-only collaborator
  refused by registration, check-in list, email draft, webhook, and attendee
  export surfaces; CSV review times in the event timezone with an offset.
  `tests/integration/judging-normalise-next.db.test.ts`: raw versus adjusted
  ranking, the owner-only audited switch, both scores in the CSV, revoked
  judges left out of the scale, and score-next order (started first, fewest
  reviews, oldest), conflicts, assignments, the done state, closed judging
  and event scoping.
  `tests/integration/judging-paging.db.test.ts`: the judge list and the
  gallery paged end to end with ties on `submittedAt` (no gaps or repeats),
  progress filters and totals, search (wildcards literal, surnames never
  matched), assignments, conflict of interest, event scoping, forged cursors,
  page clamping, and every winner kept on the results page.
  `tests/integration/judging-results-freeze.db.test.ts`: saving, submitting
  and withdrawing refused once results are published (the award kept),
  allowed before and again after unpublishing.
  `tests/integration/gallery.db.test.ts`: gallery orders with id tiebreaks,
  search (title, team, first name only, literal wildcards, bounded), the
  winners filter and awards order hidden until results are published and
  correct after (best award, place, then A–Z; disqualified winners and other
  events never shown), combined search, filter and order, invalid params
  falling back, public-safe DTOs, the results page search, and the event
  page's visibility rules (organisation, gallery switch, window, page
  release, status, invite-only) as a real 404.
  `tests/integration/judging-rounds.db.test.ts`: the first round and the
  event mirror, one OPEN round per event, round order and status rules, the
  first round taking everyone, reorder and delete, per-round panels, tenancy
  and owner/admin-only actions. `judging-rounds-advance.db.test.ts`: preview
  then apply with a fingerprint, only from a finalised round, disqualified
  and withdrawn never advance, frozen finalists, judges seeing only
  finalists, final-round results, award candidates and publication,
  finalist publication and email once, and finalising with coverage or a
  reason. `judging-rounds-assign.db.test.ts`: seeded Random runs reproduced
  and recorded, conflict-free and balanced, manual changes audited, panels
  narrowing the pool, fresh eyes. `judging-rounds-migration.db.test.ts`: the
  migration backfill, the expand-phase fill and mirror triggers, and
  cascades. `judging-rounds-frozen.db.test.ts`: a finalised round's counted
  reviews frozen against a revoked grant until unfinalised, and a deletion
  undo putting a finalist place back only into the round it was taken from
  once open. `judging-results-guards.db.test.ts`: award winners kept to the
  final round's finalists (advancement removes them, publishing refuses, the
  public page and payouts skip them), multi-round results only after
  finalising, the finalists-only page title, and the results email leaving
  crew out. `judging-recusal.db.test.ts`: recusing only from an assigned
  project in the open round before a submitted review, hidden and unscorable
  after, never reassigned to that judge, shown in Progress, undo, audited.
  `judging-judge-mfa.db.test.ts`: a `JUDGE` collaborator without this
  session's authenticator check refused by the Server Actions and by the
  cores' re-check.
  `tests/integration/hackathon-email-toggles.db.test.ts`: both switches
  `NOT NULL DEFAULT false`, also for rows written without them; publishing
  with the results switch off queues
  nothing and leaves `resultsAnnouncedAt` null; publishing with it on emails
  as before; turning it on and **Send results email now** emails each
  confirmed entrant member once, also under two concurrent sends, and
  unpublish/republish still never duplicates, including after a partly
  delivered announcement, and nobody emailed twice after a fully delivered
  one; receipts only when on; registration, team and
  submission-link emails always queued; co-organisers with every grant and
  other organisations refused; clone copies the switches.
  `tests/integration/hackathon-email-toggles-fees.db.test.ts`: on the
  entry-fee path the receipt follows the switch (provider payment, offline
  and waived settlement, read at confirmation time) while the *paid* and
  *refunded* payment emails are always queued.
  `tests/integration/judging-ops.db.test.ts`: the `reviewsPerProject` CHECK,
  preview writing nothing, apply in one transaction (assignments, judges see
  only assigned, target stored, audit), stale fingerprints refused,
  conflicts never assigned and shortfalls reported, ineligible judges
  refused and organisers only when picked, replace keeping started
  assignments, organisation scoping, closed judging and published results
  refused, every action refused to judges and outsiders, and the progress
  lists (below target, per judge, outliers, stale, page clamping).
- Unit tests: `tests/unit/hackathon-emails.test.ts` (defaults, gating,
  announcement states, dialog copy, the validator's optional switches, the
  entrant's submit confirmation), `tests/unit/judging-admin-emails.test.ts`
  (the switches passed through or left out, Send results email now gated to
  owners and admins under the broadcast bucket),
  `tests/unit/judging-paging.test.ts` (cursor, query bounds,
  `?page=`/`?q=` parsing, page clamping, gallery links),
  `tests/unit/gallery-query.test.ts` (`?filter=`/`?sort=` parsing and
  fallbacks, publication gating, short links, the bound and escaped search,
  event scoping, and every order's id tiebreak),
  `tests/unit/judging-assignment.test.ts` (balance, conflicts, shortfalls,
  determinism, keep and replace), `tests/unit/judging-assignment-random.test.ts`
  (seeded runs per seed, across seeds, conflicts, coverage and loads),
  `tests/unit/judging-advancement.test.ts` (top N, ties at the cut, hand
  picks, the fingerprint), `tests/unit/judging-rounds-copy.test.ts`, `tests/unit/judging-progress.test.ts`
  (outlier and stale rules, target, schemas),
  `tests/unit/judging-ops-copy.test.ts`,
  `tests/unit/event-capabilities.test.ts` (judging flags for every
  role and grant), validators (URLs `https:` only), the score formula and
  the hand-computed adjusted-score fixtures (`tests/unit/judging-score.test.ts`), DTOs for
  public results, gallery, and judge views (forbidden fields), the outbox
  payloads, and `tests/unit/judging-panel-copy.test.ts` (not-live warnings,
  publish hints, organiser versus judge copy, invited judges versus
  organisers, disqualify and reinstate impact, entrant window lines, the
  zoned CSV timestamp, and the active-tab scroll target).
- End to end (`tests/e2e/judging.spec.ts`): the core journey, plus the draft
  warning, state-accurate publish hints, the organiser rubric link, the judges
  split, the disqualify warning after publication, and the active tab scrolled
  into view on a phone. `tests/e2e/judging-ops.spec.ts`: automatic
  assignment previewed and applied from Progress (even loads, a judge's own
  project skipped, judges then see only assigned), the outlier and stale
  lists, and no Progress view for a `JUDGE`-only collaborator.
  `tests/integration/saved-views.db.test.ts` and `tests/e2e/saved-views.spec.ts`
  cover the Not submitted, Unscored and Below target views.

## Choosing participants with applications

A hackathon can choose its teams or entrants with applications ([ADMISSION.md](ADMISSION.md)), like any other event: registrations are reviewed in stages by `REVIEW_APPLICATIONS` reviewers, and places are offered and accepted (and paid, with the leader paying once for a team). Judging projects stays in the Judging tab. Admission reviewer assignment uses the same seeded planner as judging (`lib/assignmentPlanner.ts`, shared; judging plans are pinned byte-identical by `tests/unit/assignment-planner-parity.test.ts`).
