# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]
### Added

- **Team registration** for one-off events (hackathons, game jams, competitions), specified in `docs/TEAMS.md`. Event settings `registrationMode`, `teamMinSize`, `teamMaxSize` and `soloPolicy` in the Publishing section. In team mode capacity counts units (each team or solo registrant is one), under the same event row lock as every other capacity change. Registrants create a team, join one through its link (`/:orgSlug/:eventSlug/team/:joinToken`), or register solo where allowed. Leaders manage their team from a private link (`/team/:token`, stored hashed) or **Account → Registrations**: rename, regenerate links, add and remove members, hand over leadership, and disband. *Looking for a team* profiles, invitations and join requests on *Solo with matching* events. Organisers approve, reject, promote, rename, move members, and delete teams (with undo) from the Guests tab's Teams view. New outbox kinds `team-created` and `team-member-added`; status emails name the team. Team cores live in `lib/core/teams.ts` and `lib/teamUnits.ts`.
- Migration `20261104000000_team_registration` (additive only: new enums, columns, tables, CHECK constraints, and a partial unique index for one pending join request per team and registration).
- PostgreSQL integration suite `tests/integration/teams.db.test.ts`.
- **Hackathon submissions, judging, and results**, specified in `docs/HACKATHON.md`. Confirmed entrants (teams, or solo registrations) save, submit, edit, and withdraw a project within an organiser-set window, from the team page, `/account/submissions/:eventId`, or a solo registrant's emailed `/submit/:token` link (requested from the ticket page, stored hashed). Organisers manage settings, a weighted rubric, judge assignments, disqualification, awards, and results in the new **Judging** dashboard tab, which appears once an event uses judging (submissions are turned on from Settings, so other events keep eight tabs). A new `JUDGE` co-organiser permission opens only the judging workspace; judges never see entries their own account is registered on. Result scores average each judge's weighted percentage, rounded to one decimal, with shared tie ranks. Published results appear at `/:orgSlug/:eventSlug/results` and a public project gallery at `/:orgSlug/:eventSlug/projects`, both under the event page's access rules. Scores export as CSV at `GET /api/exports/events/:eventId/judging` (owners and admins, audited `JUDGING_SCORES_EXPORTED`). New outbox kinds `submission-received`, `submission-link`, and `results-published`; new audit actions for settings, judging status, disqualification, reinstatement, and results publication. Cores live in `lib/core/judging.ts`.
- Migration `20261104010000_hackathon_judging` (additive only: the `JUDGE` permission value, new enums, event columns, eight tables, and CHECK constraints for one entrant per submission, `https:` links, window order, weight and score ranges, and award places).
- PostgreSQL integration suite `tests/integration/judging.db.test.ts`.

### Changed

- On team events, approving, rejecting, or promoting a single registration that belongs to a team is refused; organisers act on the whole team instead. Self-cancellation, organiser delete and restore, and the capacity-lowering check in `updateEvent` count units on team events. `INDIVIDUAL` events behave as before.
- The collaborator invite form offers **Judge** (never on a series; repeated permissions are refused).
- The personal data export (`GET /api/exports/account`) includes the projects of the user's registrations (never judges' scores, comments, or disqualification reasons).

### Security

- Submission links are random 256-bit tokens stored only as SHA-256 hashes, emailed only to the registration's own address (at most once a minute), and retired when replaced; the outbox deletes the message after delivery. The ticket QR alone never opens a submission.
- `JUDGE` never satisfies any other event permission check. Judges see project content only, never entrant emails, answers, or tickets, and never an entry their own account is registered on. Disqualification reasons and judge comments stay organiser-only; scores and comments are never public.
- Entrant, judge, and organiser ids are re-read with their event and organisation inside each write transaction, and the submission window is compared with server time there.
- A registration without a team on an event that registers teams only is refused with the code `TEAM_REQUIRED`.
- Team changes send organisation webhooks like individual RSVPs: one `registration.status_changed` per member for whole-team approve, reject and promote, automatic team promotion, moves into a team, leader removals and disbanding (`CANCELLED`), organiser team deletion (`REMOVED`) and its undo, and `registration.created` when a leader adds a member. Undoing a team deletion (or a last-member deletion) restores the members' custom check-in list records, like the single-RSVP undo.


### Added

- **Custom check-in lists.** Organisers add lists beyond venue entry ("Swag collection", "Lunch – Day 1", "Workshop B") from **Manage lists** on the Check-in tab or page (owners/admins and `EDIT_DETAILS` co-organisers), and anyone who can check people in (`CHECK_IN`) switches the desk from **Entry** to a list, then scans, types a code or searches to mark guests, with undo, "already checked in to <list> at <time>" feedback, collected / eligible counts and a collected / not collected guest view. Same eligibility and Override as entry, an optional "only after entry check-in" rule, read-only archived lists, a `Check-in: <list>` column per list in the attendee CSV, and list chips in the Guests list. Entry check-in, the live ticket and the entry history are unchanged. New Server Actions in `app/actions/checkin-lists.ts` over `lib/core/checkinLists.ts`; migration `20261103000000_check_in_lists` is additive. Standalone events only for now.
- **Organisation webhooks.** Owners and admins can send their organisation's events to their own systems from **Settings → Webhooks**: up to 10 endpoints, each with subscribed event types (`registration.created`, `registration.status_changed`, `checkin.created`, `checkin.undone`, `event.published`, `event.cancelled`, `feedback.submitted`, plus a `ping` test), a `whsec_` signing secret shown once and stored encrypted, Rotate secret, Send test, Enable/Disable, Delete, and a delivery log with Redeliver. Requests carry `x-yuyu-signature` (HMAC-SHA256 over `<t>.<body>`), minimal DTOs without emails, answers or tokens, retry with jittered backoff (8 attempts over about a day) from the existing outbox worker, and an endpoint is switched off after 20 consecutive failures. Targets are SSRF-restricted (public https on 443/8443, every resolved address checked at save and delivery time, pinned connection, no redirects). New `webhookManage`/`webhookTest` rate-limit buckets, development/test-only `WEBHOOKS_ALLOW_PRIVATE_TARGETS`, and additive migration `20261103010000_org_webhooks`; app processes need outbound HTTPS to receivers. See `docs/WEBHOOKS.md`.
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
