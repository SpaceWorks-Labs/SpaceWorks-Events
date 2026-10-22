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

Production mode prepares and starts `.next/standalone/server.js`, including public and static assets. The suite checks liveness, Auth.js polling limits, mobile navigation, login/crawler controls, confirmed tickets, waitlisted ticket rejection, feedback, JPEG certificates, and short-link redirects and not-found behaviour. `broadcast-drafts.spec.ts` checks that a custom email autosaves, guards leaving while unsaved, survives a reload, asks before a template replaces it, and is cleared by a real send after the undo window, and that **Discard draft…** removes it. `check-in-lists.spec.ts`: an admin creates a "Swag" list from Manage lists, checks a confirmed guest in by search (count goes to 1), gets "Already checked in to Swag at …" for the typed ticket, undoes it, filters the list's guest view, and then checks the same guest in at Entry independently; a `CHECK_IN`-only co-organiser scans a ticket into the list but sees no Manage lists. `webhooks.spec.ts` adds a webhook endpoint as an admin (local receiver; needs `WEBHOOKS_ALLOW_PRIVATE_TARGETS=1`), sees the secret once, sends a test and sees the 200 in the delivery log with a valid signature, and checks that a member is redirected away from the settings and Webhooks pages.

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
