# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Added

- **Paid team registration.** Team events can sell tickets: **Tickets → Who pays for teams** picks every member (default) or the leader once per team. Team places are paid up front: a leader's new team is held as `PENDING_PAYMENT` (and takes a unit) while they pay, a member paying to join waits outside the team until the money lands, and the place is then confirmed or, on approval events, awaits approval. Paid team places never wait on the waitlist; a late payment whose place is gone is refunded. Rejecting a team refunds its members' paid orders in full; cancelling a per-team leader's order cancels the whole team. Leaders can't remove paid members, disband or be deleted with paid members: paid tickets are cancelled as orders. The join link sells the ticket on per-member events. Core in `lib/payments/teamOrders.ts`; the teams-and-tickets guard is gone (group tickets stay off team events).
- **Hackathon entry fees.** Settings → Project entry fee: entrants pay once through the checkout when they submit (the project stays a draft until paid), and a paid fee is refunded in full on disqualification when set. Settled online, by hand or waived like any order. `lib/payments/entryFees.ts`.
- **Prize money and payouts.** Awards can carry a prize per winner; Judging → Prizes (owners and admins) records payouts made by hand in the append-only `PrizePayout` ledger, with reversals instead of edits. New chat event *Payouts*.
- **Check-in lists for an extra.** A new list can be limited to the buyers of an add-on; guests pass only if their confirmed order bought it, as many times as it was bought, and the list's counts follow the quantity sold.
- **Webhooks on payment paths.** Placing a paid order raises `registration.created`, paying it `registration.status_changed` from `PENDING_PAYMENT`, and cancelling an order's tickets `CANCELLED`.
- Migration `20261105000000_paid_options` (additive: the `TeamTicketMode` enum, `Event.teamTicketMode`, `submissionFeeMinor` and `submissionFeeRefundOnDisqualify`, `Order.teamId`, `teamName` and `submissionId`, `EventAward.prizeMinor`, `CheckInList.addOnId`, the `PrizePayout` table with its append-only and reversal triggers, CHECK constraints, and `payout` in `ChatChannel_shape`). PostgreSQL suites `tests/integration/paid-teams.db.test.ts` and `paid-extras.db.test.ts`.

- **Team registration** for one-off events (hackathons, game jams, competitions), specified in `docs/TEAMS.md`. Event settings `registrationMode`, `teamMinSize`, `teamMaxSize` and `soloPolicy` in the Publishing section. In team mode capacity counts units (each team or solo registrant is one), under the same event row lock as every other capacity change. Registrants create a team, join one through its link (`/:orgSlug/:eventSlug/team/:joinToken`), or register solo where allowed. Leaders manage their team from a private link (`/team/:token`, stored hashed) or **Account → Registrations**: rename, regenerate links, add and remove members, hand over leadership, and disband. *Looking for a team* profiles, invitations and join requests on *Solo with matching* events. Organisers approve, reject, promote, rename, move members, and delete teams (with undo) from the Guests tab's Teams view. New outbox kinds `team-created` and `team-member-added`; status emails name the team. Team cores live in `lib/core/teams.ts` and `lib/teamUnits.ts`.
- Migration `20261104000000_team_registration` (additive only: new enums, columns, tables, CHECK constraints, and a partial unique index for one pending join request per team and registration).
- PostgreSQL integration suite `tests/integration/teams.db.test.ts`.
- **Hackathon submissions, judging, and results**, specified in `docs/HACKATHON.md`. Confirmed entrants (teams, or solo registrations) save, submit, edit, and withdraw a project within an organiser-set window, from the team page, `/account/submissions/:eventId`, or a solo registrant's emailed `/submit/:token` link (requested from the ticket page, stored hashed). Organisers manage settings, a weighted rubric, judge assignments, disqualification, awards, and results in the new **Judging** dashboard tab, which appears once an event uses judging (submissions are turned on from Settings, so other events keep eight tabs). A new `JUDGE` co-organiser permission opens only the judging workspace; judges never see entries their own account is registered on. Result scores average each judge's weighted percentage, rounded to one decimal, with shared tie ranks. Published results appear at `/:orgSlug/:eventSlug/results` and a public project gallery at `/:orgSlug/:eventSlug/projects`, both under the event page's access rules. Scores export as CSV at `GET /api/exports/events/:eventId/judging` (owners and admins, audited `JUDGING_SCORES_EXPORTED`). New outbox kinds `submission-received`, `submission-link`, and `results-published`; new audit actions for settings, judging status, disqualification, reinstatement, and results publication. Cores live in `lib/core/judging.ts`.
- Migration `20261104010000_hackathon_judging` (additive only: the `JUDGE` permission value, new enums, event columns, eight tables, and CHECK constraints for one entrant per submission, `https:` links, window order, weight and score ranges, and award places).
- PostgreSQL integration suite `tests/integration/judging.db.test.ts`.
- **Adjust for harsh/generous judges.** A switch on Judging → Results (owners and admins, audited `JUDGING_SCORE_NORMALIZATION_CHANGED`) ranks projects by an adjusted score: each judge's weighted percentages are standardised against their own counted reviews (`50 + 15 × z`, clamped to 0..100; judges with fewer than 3 reviews or identical scores stay raw), then averaged per project. The table shows raw and adjusted columns with the ranking one marked, the Awards picker follows the active ranking, and the judging CSV gains *Raw score* and *Adjusted score* columns (columns after *Result score* move two places right). Stored in `Event.scoreNormalization` (`RAW` default, `ZSCORE`). Public pages still never show scores.
- **Score next project** in the judge workspace: the server picks a project the judge started, else the one with the fewest submitted reviews (oldest first), within the judge's visibility (assignments, conflicts, judging open). After a fresh review is submitted the next project opens automatically with a toast and a way back to the list, ending in a "You're all caught up" state. New Server Action `loadNextJudgeSubmission` and core `nextSubmissionForJudge`. PostgreSQL suite `tests/integration/judging-normalise-next.db.test.ts`.
- **Automatic judge assignment and judging progress.** A new Judging → **Progress** view (owners and admins) lists projects below the target number of submitted reviews, each judge's assigned / started / submitted reviews with completion, outlier scores (more than 2 SD from the other judges' mean, or two judges more than 25 points apart) and reviews left unsubmitted for over 24 hours, as numbered pages of 25. **Assign judges automatically** previews then applies an even, deterministic assignment of N judges to every submitted project from the picked judges (invited judges by default, organisers only when ticked), never a judge registered on the entry, keeping or replacing current assignments (started ones are always kept, and projects judges already started while seeing every project become their assignments and count towards N, so nobody loses work in progress) and reporting projects that can't reach N; apply re-plans under the event lock, refuses a plan that changed since the preview, switches judges to assigned projects only and is audited (`JUDGES_AUTO_ASSIGNED`). The target is stored in the new `Event.reviewsPerProject` (1 to 20; audited `JUDGING_REVIEW_TARGET_UPDATED`). Cores in `lib/core/judgingOps.ts`, Server Actions in `app/actions/judging-ops.ts`. PostgreSQL suite `tests/integration/judging-ops.db.test.ts`.
- Migration `20261104030000_judging_ops` (additive only: the `ScoreNormalization` enum, `Event.scoreNormalization` defaulting to `RAW`, and the nullable `Event.reviewsPerProject` with a 1..20 CHECK constraint).
- **Saved views** on the event dashboard's lists (Guests → People and Teams, Judging → Submissions, Results and Progress). Filters and search now live in the address bar (allow-listed per list; unknown keys dropped; cleared when the tab or sub-tab changes), and a **Views** menu offers built-in presets (People *Waitlisted*, *Checked in*, *Not checked in*, *Solo*; Teams *Incomplete*, *Pending approval*, *Looking for members*; Submissions *Not submitted*, *Drafts*, *Disqualified*; Results *Unscored*, *Scored by fewer than 2 judges*; Progress *Below target*), your own and shared views, **Save current view…**, **Manage views…** (rename, share, delete; owners and admins also delete shared views) and **Copy link**. New server-side filters with counts: People `notCheckedIn`, Teams `looking`, Submissions *Not submitted* (confirmed teams and solo registrants without a submitted project, `lib/core/judgingEntrants.ts`), Results `scored`, and a Progress list switch. Views are stored in the new `SavedView` table, validated against the list's allow-list on write and read, gated by the list's own permission (a view never grants access), scoped to event and organisation, rate limited on the `action` bucket and audited on create, delete and share (`SAVED_VIEW_*`). Cores in `lib/core/savedViews.ts`, actions in `app/actions/saved-views.ts`. PostgreSQL suite `tests/integration/saved-views.db.test.ts`, e2e `tests/e2e/saved-views.spec.ts`.
- Migration `20261104040000_saved_views` (additive only: the `SavedViewSurface` enum and the `SavedView` table with name-length and object-params CHECK constraints, an `(eventId, surface)` index, and cascades from event, organisation and user).
- **Filtered CSV exports.** Guests · People, Guests · Teams, Judging → Submissions and Judging → Results each have **Export CSV** for exactly the filters and search showing, read on the server through the view's own query and streamed in bounded keyset batches (no rows from the browser): `GET /api/exports/events/:eventId/attendees` accepts the People filters (`status`, `kind`, `team`, `q`; unchanged without them), the new `GET /api/exports/events/:eventId/teams` (`status`, `q`; team, status, size, incomplete, looking for members, leader, members, submission status; audited `TEAM_LIST_EXPORTED`), and `GET /api/exports/events/:eventId/judging` accepts the Results search, score chip and the score method the table shows (`q`, `scored`, `method`) or `view=submissions` with `status` and `q` (audited `JUDGING_SUBMISSIONS_EXPORTED`). Each keeps its screen's permission, answers every denial and malformed parameter with an empty 404, neutralises spreadsheet formulas, and audits the surface and filter names only. Shared helpers in `lib/csvExport.ts`.
- **Public gallery search, filter and sort.** `/:orgSlug/:eventSlug/projects` adds **Newest** (now the default order), **A–Z** and, once results are published, **Awards first** (`?sort=`), an **Award winners** filter with its count (`?filter=winners`, published results only) and award badges (award name and place) on winning projects, on top of the existing `?q=` search and page numbers. Everything runs in SQL with `id` tiebreaks (`lib/galleryQuery.ts`); invalid or not-yet-allowed values fall back to the defaults, so winners are never revealed early. The controls are a GET form and links (no JavaScript needed) with the result count in a polite live region; filtered views keep a canonical URL without filter params and are not indexed. `/:orgSlug/:eventSlug/results` gains the same `?q=` search once it lists more than 10 winners. Visibility, publication and invite rules and the minimal public DTOs are unchanged. PostgreSQL suite `tests/integration/gallery.db.test.ts`, unit `tests/unit/gallery-query.test.ts`, e2e `tests/e2e/gallery.spec.ts`.

### Changed

- Feedback → **Show individual responses** pages on the server, 25 at a time with numbered pages (`loadFeedbackResponsesPage`, owners and admins), instead of stopping at the 250 most recent responses.
- **Large-event lists are paged on the server.** Team, guest, check-in and judging lists no longer load every row into the browser or silently stop at a fixed cap (the old 250-guest, 200-team, 200-check-in and 100-row limits are gone). Every page goes through a read-only Server Action that re-checks the same permission as its screen, re-scopes by event and organisation, and uses the `search` rate-limit bucket; every order ends in a unique `id` tiebreak, and counts come from separate queries under the same filters. Guests · Teams loads 50 at a time with **Load more**; Guests · People loads 50 at a time with server-side filters, search and chip counts (the series page uses the same list); **Export emails** downloads every match of the current filters from the new `GET /api/exports/events/:eventId/attendee-emails` (same access as the attendee CSV, 404 on every denial, audited as `ATTENDEE_LIST_EXPORTED` with filter names only); the Move to team picker searches teams with room, 20 at a time; Invites shows numbered pages of 50 with an email search; the check-in desk and venue station load Recent check-ins 25 at a time; custom check-in list rosters page 100 at a time with server search and per-chip counts; the team page and ticket page page their *Looking for a team* lists, teams looking for members, invitations and requests 20 at a time; **Account → Registrations** pages each section (50 per page, `?upcoming=`/`?past=`/`?certificates=`). Judging: the judge's **Score** list loads 25 at a time with filter counts and search (visibility, assignments and conflicts of interest still applied in the query); **Submissions** loads 50 at a time with server-side status filter and search; **Results** shows numbered pages of 50 over the whole ranking (ranks and ties unchanged by paging or search); the Awards winner picker searches ranked submitted projects 20 at a time; **Judges** progress comes from aggregates. The public project gallery shows 24 projects per page (`?page=N`, `?q=` search on title, team name or a solo entrant's first name; each page has its own canonical URL and searches are not indexed). "Load more" and "Show more" move keyboard focus to the first new row, and numbered pagers share one control (`components/ui/page-number-pager.tsx`) with 44px targets.
- On team events, approving, rejecting, or promoting a single registration that belongs to a team is refused; organisers act on the whole team instead. Self-cancellation, organiser delete and restore, and the capacity-lowering check in `updateEvent` count units on team events. `INDIVIDUAL` events behave as before.
- The collaborator invite form offers **Judge** (never on a series; repeated permissions are refused).
- The personal data export (`GET /api/exports/account`) includes the projects of the user's registrations (never judges' scores, comments, or disqualification reasons).

### Security

- Submission links are random 256-bit tokens stored only as SHA-256 hashes, emailed only to the registration's own address (at most once a minute), and retired when replaced; the outbox deletes the message after delivery. The ticket QR alone never opens a submission.
- `JUDGE` never satisfies any other event permission check. Judges see project content only, never entrant emails, answers, or tickets, and never an entry their own account is registered on. Disqualification reasons and judge comments stay organiser-only; scores and comments are never public.
- Entrant, judge, and organiser ids are re-read with their event and organisation inside each write transaction, and the submission window is compared with server time there.
- A registration without a team on an event that registers teams only is refused with the code `TEAM_REQUIRED`.
- Team changes send organisation webhooks like individual RSVPs: one `registration.status_changed` per member for whole-team approve, reject and promote, automatic team promotion, moves into a team, leader removals and disbanding (`CANCELLED`), organiser team deletion (`REMOVED`) and its undo, and `registration.created` when a leader adds a member. Undoing a team deletion (or a last-member deletion) restores the members' custom check-in list records, like the single-RSVP undo.

### Fixed

- The event dashboard no longer renders a streamed panel twice. next-auth's `<SessionProvider>` fetched the session after the first client render and changed its context value while the page's `loading.tsx` Suspense boundary was still waiting for React's batched reveal; React then gave up hydrating that boundary and rendered the panel again on the client, leaving the server copy in the hidden `div#S:1` streaming container (duplicate ids such as `#guest-search`, and in a background tab until it was shown). Client components now read the session from a small store (`components/auth/useAuthSession.ts`) whose updates re-render only its readers, and the provider is gone; `tests/e2e/filtered-exports.spec.ts` asserts a single `#guest-search` from the first byte.

### Added

- **Custom check-in lists.** Organisers add lists beyond venue entry ("Swag collection", "Lunch – Day 1", "Workshop B") from **Manage lists** on the Check-in tab or page (owners/admins and `EDIT_DETAILS` co-organisers), and anyone who can check people in (`CHECK_IN`) switches the desk from **Entry** to a list, then scans, types a code or searches to mark guests, with undo, "already checked in to <list> at <time>" feedback, collected / eligible counts and a collected / not collected guest view. Same eligibility and Override as entry, an optional "only after entry check-in" rule, read-only archived lists, a `Check-in: <list>` column per list in the attendee CSV, and list chips in the Guests list. Entry check-in, the live ticket and the entry history are unchanged. New Server Actions in `app/actions/checkin-lists.ts` over `lib/core/checkinLists.ts`; migration `20261103000000_check_in_lists` is additive. Standalone events only for now.
- **Organisation webhooks.** Owners and admins can send their organisation's events to their own systems from **Settings → Webhooks**: up to 10 endpoints, each with subscribed event types (`registration.created`, `registration.status_changed`, `checkin.created`, `checkin.undone`, `event.published`, `event.cancelled`, `feedback.submitted`, plus a `ping` test), a `whsec_` signing secret shown once and stored encrypted, Rotate secret, Send test, Enable/Disable, Delete, and a delivery log with Redeliver. Requests carry `x-spaceworks-signature` (HMAC-SHA256 over `<t>.<body>`), minimal DTOs without emails, answers or tokens, retry with jittered backoff (8 attempts over about a day) from the existing outbox worker, and an endpoint is switched off after 20 consecutive failures. Targets are SSRF-restricted (public https on 443/8443, every resolved address checked at save and delivery time, pinned connection, no redirects). New `webhookManage`/`webhookTest` rate-limit buckets, development/test-only `WEBHOOKS_ALLOW_PRIVATE_TARGETS`, and additive migration `20261103010000_org_webhooks`; app processes need outbound HTTPS to receivers. See `docs/WEBHOOKS.md`.
- Role-based access control utilities (`requireAuth`, `requireOrgRole`, `canManageEvents`, `canManageMembers`, `canDeleteOrg`)
- Organisation dashboard (`/dashboard/[orgSlug]`) with stats, event list, and FAB create actions
- Event management panel (`/dashboard/[orgSlug]/event/[eventId]`) with tabs:
  - Overview, details editing, attendees table, invites, analytics cards, and check-in link
- Attendee management:
  - Search + filters
  - Delete RSVP
  - Approve/reject pending approvals
  - Promote from waitlist
- Organisation member management (`/dashboard/[orgSlug]/members`) with role changes/removals (owner-gated)
- Organisation invite links (`OrganisationInvite`) for adding members (token-based)
- Event status extended with `HIDDEN`
- Event privacy types: `PUBLIC`, `HIDDEN_LINK`, `APPROVAL_REQUIRED`, `INVITE_ONLY`
- RSVP status lifecycle: `CONFIRMED`, `WAITLISTED`, `PENDING_APPROVAL`, `REJECTED`
- RSVP API (`POST /api/rsvp`) backed by shared RSVP core (guest + logged-in)
- Rate limiting middleware for API/auth/RSVP/search (`middleware.ts` + `lib/rateLimit.ts`)
- Global discovery and search:
  - `/discover` public listings (filters + popular sort)
  - `/search` page and `GET /api/search?q=…` endpoint
- Invites for access control:
  - `EventInvite` for single events
  - `SeriesInvite` for recurring series
- Recurring events foundation:
  - `EventSeries` + `EventInstance` models
  - RRULE/ICS expansion + instance materialization (`lib/recurrence.ts`)
  - Series management dashboard (`/dashboard/[orgSlug]/series/[seriesId]`)
- Ticketing + check-in tooling:
  - Per-RSVP `checkInToken`, `checkedInAt`
  - Ticket page (`/ticket/[token]`) with QR panel + shareable link
  - Event check-in station (`/dashboard/[orgSlug]/event/[eventId]/check-in`)
- Modular stubs:
  - Email abstraction (`lib/email/*`) (no-op stub)
  - S3-compatible storage abstraction (`lib/storage/*`) (no-op stub)
- `.gitignore` tightened to exclude common local/generated artifacts (editor folders, caches, logs, temp files, local Prisma DB files)

### Changed

- Authentication: replaced email magic-link provider with an **email + password** Credentials provider (bcryptjs-hashed `User.passwordHash`) alongside existing Google OAuth. Sessions now use JWT strategy (required by Credentials). Login UI offers Sign in / Create account tabs.
- RSVP capacity handling: full events now place new RSVPs on `WAITLISTED` (instead of hard-blocking)
- Database schema expanded to support invites, RSVP lifecycle/check-in, privacy, and recurring series/instances

### Removed

- `nodemailer` dependency and the magic-link email stub in `lib/auth.ts`

## [0.1.0] - 2026-04-20

### Added

- Next.js 16 (App Router) with TypeScript
- PostgreSQL via Prisma ORM (v6) with Docker Compose for local development
- Auth.js / NextAuth v5: Google OAuth (optional via env) and email magic link with **stub** `sendVerificationRequest` (logs link to server console)
- Domain models: `User`, `Organisation`, `Membership` (OWNER / ADMIN / MEMBER), `Event` (DRAFT / PUBLISHED), `RSVP` (logged-in or guest email) with `attendeeKey` for deduplication
- Organisation creation with creator as OWNER (transaction)
- Event creation with title-based slug and collision suffix; members can create; only OWNER/ADMIN can publish or create as PUBLISHED
- Public org page `/{orgSlug}` and public event page `/{orgSlug}/{eventSlug}` (published events; draft events visible to org members only)
- RSVP server action with capacity check and duplicate handling
- Material UI v9 theme (MD3-inspired tokens), responsive layout, event cards, dialogs, RSVP form
- Zod validation for org, event, and RSVP payloads
- SEO: `generateMetadata` on published event pages
- Documentation: `docs/FUTURE_PHASES.md` for deferred scope and later phases

### Security

- Dashboard routes require session
- Event creation requires organisation membership
- Publishing requires OWNER or ADMIN
- Public RSVP only for PUBLISHED events

### Not in scope (Phase 1)

- Recurring events, waitlists, invite-only flows, approval workflows
- Transactional email delivery (beyond development stub)
- Analytics, ticketing, payments
