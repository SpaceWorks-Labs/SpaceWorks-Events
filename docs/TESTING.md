# Testing and quality gates

[Documentation index](README.md)

## Test suites

### Unit tests

```bash
npm run test:unit
```

Fast Vitest tests cover validation and isolated domain/security behavior. Watch mode is available with `npm run test:unit:watch`.

Machine API coverage includes bearer parsing and hashing, credential state, strict DTOs, cursor validation, scope behavior, and forbidden-field regression checks.

Other security-relevant unit suites include `event-capabilities` (the dashboard permission matrix in `docs/PERMISSIONS.md` for every role and grant), `super-admin-page-guards` (fails if any `app/super-admin/**/page.tsx` omits `await requireSuperAdminMfa()`), the live-ticket suites (`ticket-check-in-events`, `ticket-check-in-publish`, `ticket-check-in-routes`, `ticket-check-in-watcher`, `use-ticket-check-in`), `account-data-export` and `account-organisations-actions`, `short-link-actions` and `short-link-resolve`, `broadcast-designs`, `event-publishing`, `safe-http-url`, `image-validation`, `mfa-proof` and `mfa-step-up-action` (the staff authenticator proof cookie and `/verify-mfa` action), and `pwned-passwords` (k-anonymity request, padding, fail-open behaviour).

The Vitest, Playwright and split-hosting runs set `STAFF_MFA_REQUIRED`, `LOGIN_NEW_DEVICE_CHECK` and `PWNED_PASSWORDS_CHECK` to `false`, so suites do not need authenticator codes, emailed sign-in codes or network access to Have I Been Pwned. Tests of those protections turn them back on with `vi.stubEnv`.

Custom check-in lists are covered by `event-capabilities` (including the check-in list flags), `check-in-lists` (list schemas, the list eligibility gate reusing the entry gate, the duplicate message and eligible counts) and `attendee-export-route` (including the per-list CSV columns).

Organisation webhooks are covered by `webhooks` (signature against a fixed HMAC vector and verification, whsec_ secret shape, domain-separated secret encryption, every blocked IPv4/IPv6 range including IPv4-mapped, NAT64 and 6to4 forms, decimal/hex/octal IP literals, `localhost.` and internal names, ports and URL credentials, the dev/test flag never honoured in production, DNS answers with any private address, pinned lookup, host-only audit labels, payload DTO forbidden-field regression, and the retry schedule with jitter), `production-check-script` (refuses `WEBHOOKS_ALLOW_PRIVATE_TARGETS`), `retention` and `outbox-worker` (webhook purge and delivery in the scheduler pass), and `migration-safety`.

Team registration unit suites are `team-validators` (event team settings, series refusal, team names, registration intents, seeker limits), `team-units` (unit counting, oldest-unit promotion, leadership handover), `team-token` (token shape and SHA-256 storage), `team-dto` (join page and seeker list never expose member names, emails, answers, or tickets), `team-outbox` (the `team-created` and `team-member-added` kinds, dropped when the link was retired), and `guest-list-teams` (the Guests list "In a team" and "Solo" filters and team-name search).
Hackathon judging unit suites are `judging-validators` (submission content with `https:`-only links checked by `URL`, settings, rubric, awards, scores, and reviews), `judging-score` (the result-score formula, one-decimal rounding, and shared tie ranks), `judging-dto` (public results, gallery, judge, and entrant views never expose emails, answers, tickets, scores, comments, or disqualification reasons), `judging-outbox` (the `submission-received`, `submission-link`, and `results-published` kinds; the link token is a capability), `hackathon-emails` (the opt-in results and receipt emails: defaults, gating, announcement states, dialog copy, the optional switches, the submit confirmation), `judging-admin-emails` (the switches through `saveJudgingSettings` and Send results email now for owners and admins only), `judging-permissions` (JUDGE opens only the judging workspace; judge-only detection), `event-collaborator-actions` (JUDGE grants, never on a series), `submission-actions` (how the team page, account, and submission link reference a project; audit; the ticket page's link request), `submission-account` (projects in the personal data export and the Account → Registrations link), `judge-workspace` (judge progress and score inputs), and `project-links` (public project links).


### PostgreSQL integration tests

```bash
docker compose up -d
TEST_DATABASE_URL="postgresql://swevents:swevents_dev@localhost:5432/swevents_test" npm run test:integration
```

These tests exercise real constraints, transactions, audit triggers, RSVP
capacity, and feedback persistence. `TEST_DATABASE_URL` is mandatory so the
suite cannot silently inherit the application's ambient `DATABASE_URL`. Keep
the named database disposable and never point it at production.

The machine API integration suite additionally exercises persisted credential hashes, cross-tenant event access, participant privacy, and bounded collections. The short-link suite covers owner/admin-only creation, cross-tenant rejection, idempotent and concurrent creation, regeneration, the unique index, and resolution for every non-published status. The `rsvp-reaccept` and `paid-reaccept` suites cover re-accepting a declined registration: confirmed with room, waitlisted when full and never oversold under concurrency, tenant and permission checks, and for a paid request a payment link or a waitlist place but never a confirmation without payment. The `collaborator-permissions` suite checks that co-organisers with each single grant and with every grant are refused delete, clone, address changes, publishing, short links, series deletion and collaborator management, while `MANAGE_INVITATIONS` and `MANAGE_REGISTRATIONS` reach exactly the invite and RSVP actions, on the event or (for a series grant) the series only. The `login-security` suite covers first-device trust and new-device alerts, single-use hashed sign-in codes, per-account and per-address failure counting (never blocking an "unknown" address), and the staff authenticator rule, including the exemptions for attendees and the super admin. The `broadcast-drafts` suite covers Emails-tab drafts: save, load and update of one private draft per organiser, cross-tenant and member denial, body sanitising and the send schema's length limits, the database subject bound, cascades on event and user deletion, and clearing by a real send (not a test send or a failed send). The `check-in-lists` suite covers custom check-in lists: create/rename/reorder/archive for OWNER, ADMIN and an `EDIT_DETAILS` co-organiser, refused for a `CHECK_IN`-only co-organiser and a `MEMBER`, cross-organisation "Event not found."; case-insensitive unique names among open lists; eligibility (confirmed, waitlisted with and without Override, pending, declined), ticket URL input and wrong-event tickets, `requiresEntryCheckIn`, one record and one history row for two parallel check-ins, "already" with list and time, undo with history, archived lists read-only, entry check-in untouched, the attendee CSV columns, list records kept through RSVP remove-and-undo, cascades, and the database constraints. The `webhooks` integration suite covers organisation webhooks with a local HTTP receiver and `WEBHOOKS_ALLOW_PRIVATE_TARGETS`: secret shown once and encrypted at rest, events queued after RSVP create, approval, check-in and undo, cancellation, publish and feedback (no tokens or emails), signed delivery with the documented headers, one claim per row across two concurrent workers, retry with backoff on 500, 3xx not followed, Send test and rotation, redelivery with the same event id, the user action unaffected while the receiver is down, auto-disable after 20 failures, endpoint cap, cross-organisation `NOT_FOUND`, member and co-organiser denial, SSRF blocks at save time and at delivery time (a host re-resolving to 127.0.0.1 with the flag off), host-only audit metadata, and the 30-day purge.

| `teams.db.test.ts` | Team registration: unchanged `INDIVIDUAL` events, `TEAM_REQUIRED`, case-insensitive team names, concurrent team creation for the last unit, concurrent joins against `teamMaxSize`, atomic whole-team approval (refused below `teamMinSize`), no joins into rejected teams, seeker acceptance freeing a unit and promoting the oldest waitlisted unit, cross-event and cross-organisation team ids, a management token used against another team, leadership handover on leader cancel, disband promotion, organiser move/remove/delete with undo, the team CHECK constraints and one-pending-request index, and the member-status-equals-team-status invariant after every mutation |
| `judging.db.test.ts` | Hackathon judging ([HACKATHON.md](HACKATHON.md)): submissions refused outside the window, while disabled, for unpublished events, and for non-confirmed entrants; entrant, organiser, and judge ids re-scoped to another event or organisation; a solo submission link never edits another entrant, is mailed only to the registration, and is retired when regenerated; a `JUDGE`-only collaborator reaches no guests, teams, mobile organiser API, or other event; conflict of interest (team member, solo owner, org admin) hides and refuses the entry; scores refused unless judging is open and the project is submitted; concurrent submission, score, and review writes stay unique (one receipt email); the result-score formula, tie ranks, and CSV rows; awards only for submitted projects; the results page and gallery hidden until published and for unreleased, unpublished, and invite-only events |
| `dashboard-loading-boundaries.test.ts` (unit) | Every `loading.tsx` in `app/` is pinned to the layout that awaits the wrapped pages' access check (`lib/views/dashboardGuards.ts`) and to the exact pages it wraps; there is no root, dashboard-wide, organisation-wide or event-wide `loading.tsx` |
| `judging-results-equivalence.db.test.ts` | The aggregated judging reads ([Large-event performance](PERFORMANCE.md)) give exactly the previous implementation's ranking under both score methods, counted reviews, Progress outliers and stale lists, and judging CSV, on data with revoked judges, a conflict of interest, drafts, partial and out-of-range scores and ties |
| `offline-roster.db.test.ts` | The set-based offline check-in roster: eligible registrations newest first with their user, team and answers; another organisation's event refused |
| `raw-sql-timezone.db.test.ts` | Raw SQL on a database whose `TimeZone` is Asia/Kolkata: the `lib/sqlTimestamp.ts` helpers write and compare UTC wall-clock time, a webhook delivery is not claimed before its retry time, and a registration whose event ended an hour ago is filed under Past |
| `judging-core.db.test.ts` | End-to-end smoke run of the judging cores: CHECK constraints, cascades, and results publication with its emails (opted in) |
| `hackathon-email-toggles.db.test.ts` | Hackathon emails ([HACKATHON.md](HACKATHON.md) → Hackathon emails): both switches `NOT NULL DEFAULT false`; publishing with the results switch off queues nothing; Send results email now once under concurrent sends and only to entrants not yet told; receipts only when on; registration, team and submission-link emails always queued; co-organisers with every grant and other organisations refused; clone copies the switches |
| `hackathon-email-toggles-fees.db.test.ts` | The submission receipt on the entry-fee path follows the switch (provider, offline and waived settlement, read at confirmation time); the *paid* and *refunded* payment emails are never gated |
| `saved-views.db.test.ts` | Saved views: each list's own permission (People/Teams `MANAGE_REGISTRATIONS`, Judging owner/admin; a `JUDGE`, a plain member and another organisation refused), params sanitised on write and read, private versus shared listing, only creators rename or share, owners/admins delete shared views (a non-admin can't), event/surface scoping, audits without names, name and object-params CHECKs, cascades from user and event; and the preset filters: People `notCheckedIn`, Teams `looking`, Submissions *Not submitted* entrants (teams and solos, search, no emails, organisation-scoped) and Results `scored` with unchanged ranks |
| `filtered-exports.db.test.ts` | Filtered CSV exports on more rows than one server batch (531 registrations, 211 teams, 205 projects): People, Teams, Submissions and Results files hold exactly the rows their filters match with the unfiltered People file unchanged, formula-like cells neutralised, the search kept inside the event, audits with filter names only, each export's own access (a `MANAGE_REGISTRATIONS` co-organiser for People and Teams, owners/admins only for judging) and an empty 404 for members, other organisations and malformed or other-view parameters; Feedback responses paged 25 at a time once each with stable numbers, owner/admin only |
### Coverage

```bash
npm run test:coverage
```

`vitest.coverage.config.mts` runs only service-independent unit tests while
measuring all `lib/**/*.ts` and `app/actions/**/*.ts` rather than a hand-selected
source subset. PostgreSQL tests must be run separately through
`npm run test:integration` with a disposable `TEST_DATABASE_URL`. The configured
minimum is a regression floor, not a statement that coverage is sufficient.

### Browser tests

Install Chromium once:

```bash
npx playwright install chromium
```

Then run either development or production mode:

```bash
npm run test:e2e
npm run build
npm run test:e2e:production
```

Production mode prepares and starts `.next/standalone/server.js`, including public and static assets. The suite checks liveness, Auth.js polling limits, mobile navigation, login/crawler controls, confirmed tickets, waitlisted ticket rejection, feedback, JPEG certificates, and short-link redirects and not-found behaviour. `broadcast-drafts.spec.ts` checks that a custom email autosaves, guards leaving while unsaved, survives a reload, asks before a template replaces it, and is cleared by a real send after the undo window, and that **Discard draft…** removes it. `check-in-lists.spec.ts`: an admin creates a "Swag" list from Manage lists, checks a confirmed guest in by search (count goes to 1), gets "Already checked in to Swag at …" for the typed ticket, undoes it, filters the list's guest view, and then checks the same guest in at Entry independently; a `CHECK_IN`-only co-organiser scans a ticket into the list but sees no Manage lists. `webhooks.spec.ts` adds a webhook endpoint as an admin (local receiver; needs `WEBHOOKS_ALLOW_PRIVATE_TARGETS=1`), sees the secret once, sends a test and sees the 200 in the delivery log with a valid signature, and checks that a member is redirected away from the settings and Webhooks pages. `teams.spec.ts`: a serial team registration story ([Teams](TEAMS.md)): the organiser turns on team registration in Publishing, a leader creates a team through the public form (the management token is read from the queued `team-created` email), the team page shows the join link, a teammate joins through it, the join link 404s for hidden, draft, invite-only and unreleased events, a solo registrant pastes the join link on their ticket page (a management link is refused) and keeps their ticket in the team, and an organiser approves a team on an approval-required event so both members' tickets show it. `/team/:token` and the join page must send `Referrer-Policy: no-referrer`, a `noindex` robots tag, and a non-shareable `Cache-Control` (`no-store` under `test:e2e:production`; `next dev` always sends its own `no-cache`). `pagination.spec.ts`: large-event paging on seeded data (60 teams, 61 registrations, 60 ranked projects, 55 invites): Guests · People shows 50 with whole-event chip counts, Load more reaches the oldest guest, and the server search finds that guest by name and email from a fresh page; Guests · Teams loads 50 then the rest; Judging → Results shows numbered pages of 50 with ranks computed over the whole ranking (a tie keeps rank 49 across the page break); Guests · Invites shows numbered pages of 50 and searches by email. `saved-views.spec.ts`: Saved views on seeded data: People opens filtered from `?status=waitlist` (unknown keys ignored), the Views menu applies *Not checked in* and writes it to the address, Copy link holds tab, sub-tab and filters, and a sub-tab switch clears them; a Teams view is saved and shared, re-applied from a fresh visit, renamed and deleted from Manage views; Submissions *Not submitted* lists the team without a submitted project, Results opens on *Unscored*, and Progress shows only *Below target*. `filtered-exports.spec.ts`: The dashboard renders a streamed panel once (a MutationObserver from the first byte never sees two `#guest-search`, and no hidden `div#S:*` copy remains); People, Teams, Judging → Submissions and Results **Export CSV** links follow the chip and search showing and download exactly those rows; Feedback responses page 25 at a time. `dashboard-not-found.spec.ts`: dashboard refusals are real statuses, never a streamed 200: signed-out requests 307 to sign-in; an owner gets 200 on their own pages (members, member IDs, ticket designs, every settings page, check-in, badges, schedule) and 404 for another organisation's or an unknown event, series, webhook endpoint, ID programme or ticket design (without the protected title in the body) and 307 for another organisation; a member gets 307 from owner/admin pages and 404 from check-in, badges and schedule; a JUDGE-only collaborator gets 200 on their event and 404 on its check-in desk, badges, schedule and every other event. `create-event-timezone.spec.ts`: from a browser on Pacific/Auckland, the New event dialog suggests a whole hour at least 30 minutes away on the event's clock, its earliest start follows the chosen timezone, and the stored start is the picked wall-clock time in America/New_York; `/discover` does not scroll sideways at 390px with a 200-character unbroken title, tag and place, in light and dark.

## Static and dependency checks

```bash
npm run lint
npx tsc --noEmit
npm audit --audit-level=low
git diff --check
```

`npm audit` checks known advisories in the installed dependency graph. It does not detect application authorization bugs, unknown vulnerabilities, or infrastructure mistakes.

## Database and environment checks

```bash
npm run db:status
npm run db:verify
npm run production:check
```

- `db:status` confirms migration state.
- `db:verify` checks required columns, constraints, and audit triggers against the running database.
- `production:check` validates required production settings and transport requirements.

## Build and container verification

```bash
npm run build
docker build \
  --secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY --build-arg NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" \
  -t swevents:local .
```

The quality workflow runs dependency, migration, schema, lint, type, unit, integration, build, standalone-container smoke, and browser checks using PostgreSQL and Redis services. The container smoke test starts the runner with `MIGRATE_ON_START=1` and checks both `/api/health` and the bearer-protected `/api/health/db`.

Pooled-connection compatibility: Prisma's `pgbouncer=true` only disables prepared statements, so the integration suite can be pointed at a plain local database with a Supabase-style URL (`TEST_DATABASE_URL="postgresql://…/swevents_test?pgbouncer=true&connection_limit=1"`). The integration config sets `DIRECT_URL` to the same database. `tests/unit/check-production-env.test.ts` runs the preflight against a realistic Supabase/Upstash/R2/Brevo environment.

## Release test priorities

For every release, prioritize tests around:

1. Authentication, MFA, password reset, and session revocation.
2. Cross-organisation authorization and role transitions.
3. Event privacy, invitations, registration counts, discovery visibility (`listedPublicly`), and short-link resolution.
4. Capacity races, duplicate RSVP prevention, approval, waitlist, and cancellation.
5. Ticket eligibility, online/offline check-in, undo, and the live ticket tear (with and without Redis, and behind the production reverse proxy).
6. Anonymous feedback and certificate-enabled feedback.
7. Upload rejection, object storage, outbox delivery, and retention.

## Production VPS stack

For the full single-host deployment, follow [VPS deployment](DEPLOYMENT_VPS.md).
Use a disposable VPS or an isolated Compose project for deployment tests, with
fresh generated credentials. Do not reuse a production configuration directory.

```bash
scripts/vps-compose.sh config --quiet
scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/check.mjs preflight
scripts/vps-compose.sh up -d --wait --wait-timeout 180
scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/check.mjs
```

On a disposable stack only, the additional smoke test creates and rolls back
an audited organisation and checks an object upload/download/delete roundtrip,
anonymous storage rejection, plain-text database rejection and page rendering:

```bash
scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/smoke.mjs
```

The final check verifies real database TLS and the runtime role, the schema,
authenticated Redis over TLS, bucket access and protected readiness. Also verify
anonymous storage rejection, plain-text database rejection, repeated migrations,
setup refusing existing credentials and internal-certificate renewal. Validate
Caddy configuration and complete public HTTPS, sign-in, mail, upload and streaming
checks on a reachable test domain before deploying to production.

### The curl installer

`tests/unit/vps-installer.test.ts` covers argument validation, answer validators
and configuration generation. Changes to `install.sh` or `scripts/*vps*` also
need a run on a disposable host. Use a fresh VM, or a privileged systemd container
whose `/var/lib/docker` is a volume (in nested Docker, also set
`"features": {"containerd-snapshotter": false}` in its `/etc/docker/daemon.json`).
Push the branch, then as a sudo user:

```bash
curl -fsSL https://raw.githubusercontent.com/SpaceWorks-Labs/SpaceWorks-Events/<branch>/install.sh | bash -s -- --ref <branch>
```

Check that invalid answers are asked again, that cancelling at the summary changes
nothing, and that the stack passes `check.mjs` and `smoke.mjs`. Rerun the
one-liner for each menu entry. Push a second commit and update to it. Then take a
backup, change a row and delete an uploaded object, and run `vps-restore.sh`; both
must come back. Force a failed update (a release whose `check.mjs` fails after
preflight): `compose.env`, `current` and the running images must return to the
previous release. Interrupt a first setup after confirmation and rerun the
one-liner: it must offer to resume.


## Separate frontend / VPS backend

Run `npm run test:e2e:split` with Docker and Node.js 22. It creates disposable
PostgreSQL/Redis containers, migrates, builds both workspaces, starts production
servers on loopback ports 3100/3200, and runs the browser suite plus split-specific
tenant/MFA/gateway checks. The frontend runs with an independent Server Actions
key and without backend data, authentication, mail or storage credentials.
It removes its own containers/volumes on completion; allow both ports to be free.
Plaintext dependency URLs and HTTP are limited to the existing explicit CI test
override. Production still requires TLS. It does not test a live Netlify adapter,
external SMTP/OAuth, S3 uploads or host package installation. The VPS guide covers
those live acceptance checks and the separate TLS/storage smoke checks.

Run `npm run test:e2e:vps` for the same disposable-dependency browser checks against
the original single-runtime production application. The split-only scenarios are
skipped in that mode.

The CI `hosting` matrix runs both deployment browser suites on Node.js 22 with
disposable containers; it needs no production hosting credentials.
