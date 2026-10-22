<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Space Works Events agent guide

`CLAUDE.md` is an exact copy of this file, so every coding agent reads the same
rules. Edit `AGENTS.md`, then copy it over `CLAUDE.md`; a unit test
(`tests/unit/agent-guidance.test.ts`) fails when they differ.

## Project at a glance

Space Works Events is a self-hosted, multi-tenant platform for organizing and running events, free by default, built by Space Works (derived from Yuyu by Abhiram N J; see `NOTICE`). Events are free by default. When the super admin turns paid events on, organisations sell tickets through their own Razorpay or Stripe account, with promo codes, passes, refunds, receipts and revenue reporting (see `docs/plans/paid-events.md`). It uses Next.js 16 App
Router, React 19, TypeScript, PostgreSQL with Prisma 6, Auth.js v5, Tailwind
CSS 4 with Radix primitives, Redis, S3-compatible private storage, Nodemailer,
Vitest, and Playwright. Deployment supports Docker standalone output, the Render free-tier Blueprint
(`render.yaml`, see `docs/DEPLOYMENT_CLOUD.md`), and the Helm chart in
`charts/spaceworks-events/`.

The product currently includes organisations and member roles, public/private
events and RRULE-based series, custom RSVP forms and waitlists, event short
links, QR tickets with live check-in updates and offline check-in, ID card /
badge generation (server-saved designs, colour and logos, PDF/PNG and bulk
sheets in `lib/badge/`), feedback and layered certificates, designed broadcast and
transactional email, optional paid tickets through each organisation's own
Razorpay or Stripe account (`lib/payments/`, `docs/PAYMENTS.md`), a personal account area (registrations, organisations,
data export), and a separate super-admin operations, insights, and
instance-settings area, plus a tenant-bound machine API. Treat this as a production-oriented application:
tenant isolation, privacy, and secure operations are core behaviour rather
than optional polish.

Read the relevant page in `docs/` before changing an unfamiliar product area:

- `docs/ARCHITECTURE.md` for ownership, data flow, and deployment shape.
- `docs/ROUTES.md` for public, dashboard, admin, and operational routes.
- `docs/SECURITY.md` for non-negotiable security boundaries.
- `docs/CONFIGURATION.md` and `docs/production-operations.md` for environment
  and deployment changes.
- `docs/TESTING.md` for the appropriate verification level.

`prisma/schema.prisma` is authoritative for data model details. Do not infer a
field, constraint, or cascade from a component alone.

## Fast orientation

Space Works Events is a production-oriented, self-hosted multi-tenant event
platform by Space Works, following the Space Works brand (see "Design system"
below and `docs/DESIGN.md`). The
most sensitive current scenarios are organisation isolation and role checks;
event privacy and RSVP capacity; opaque ticket, certificate, invitation, and
password-reset links; event short links that never reveal hidden events; the
realtime ticket check-in endpoints (`/api/ticket/:token/{status,events}`,
check-in state only, channels keyed by RSVP id); the personal data export and
leave-organisation actions (own data and membership only); required
authenticator MFA for organisation staff, checked each session (`/verify-mfa`,
`lib/staffMfa.ts`); password sign-in protections (failure limits, emailed
new-device codes, new-sign-in alerts) and the breached-password check; the
super-admin access check in every super-admin page (email and password set
from the server, no separate step-up); write-only,
encrypted instance SMTP/Google settings; tenant-bound machine API credentials;
image safety; outbox email delivery with an absolute `NEXT_PUBLIC_BASE_URL`,
sent through the organisation's own SMTP server or under its name (account
email always from the platform); per-organisation chat notifications
(`lib/chat/`: encrypted webhook/bot secrets, fixed hosts or a pinned public
address for Mattermost, queued with the outbox);
server-generated ID cards (`lib/badge/`, org-isolated, storage-key-only
images); the one-line curl VPS installer (`install.sh`, `scripts/*vps*`: asks
everything before changing the host, never regenerates secrets, rolls back failed
updates or auto-deploys via a self-hosted runner; nightly age-encrypted backups with
off-site copies and a status file the app reads read-only (`/status`, never the
backups themselves); operator tools for settings changes, super-admin recovery,
support bundles and uninstall; HTTPS by Caddy, its LAN CA or an existing proxy;
bundled PostgreSQL, Redis and Silo or an external S3 bucket; `split` layout by default,
website and API containers on two hostnames); public release images
(`.github/workflows/release.yml`: `spaceworks-events-backend`, which also runs
the `migrate` and VPS-tool roles, and `spaceworks-events-frontend`; one image for
every installation, so nothing installation-specific may be compiled in, and
the placeholder origins are swapped by `scripts/docker-entrypoint.sh`; GitHub
Releases only when `VERSION` changes);
and Docker/Render/Helm
deployment with PostgreSQL (Supabase), Redis
(Upstash), S3 (Cloudflare R2), and SMTP (Brevo on port 2525).

Before changing framework behaviour, consult the relevant Next.js 16 guide in
`node_modules/next/dist/docs/`. Before changing an unfamiliar domain, consult
the matching document in `docs/` and the Prisma schema. Never expose or copy
values from `.env`; use `.env.example` for configuration names.

For instance settings, preserve this ordering: database values override legacy
environment fallbacks; secrets are encrypted at rest and never returned to the
browser; backup fields only record posture and do not control provider backups.
For the machine API, resolve the organisation from the bearer credential, check
an explicit scope, and return a deliberately minimal DTO.

Keep source files (TypeScript/TSX/MJS, tests included) at or under 300 lines,
not counting blank lines and comments (ESLint `max-lines`, an error). Split
long modules into focused parts behind the original import path, as
`lib/outbox.ts` and `lib/rsvpCore.ts` are. Generated files are exempt.

At minimum, validate targeted changes with lint, TypeScript, and the relevant
test suite. For authorization, mutation, public-route, operational, API, or
deployment changes, follow the stronger checks under Verification below and in
`docs/TESTING.md`. Other sessions may edit the tree in parallel: commit with
explicit paths only, and commit the user manual only when asked.

Every new feature goes on its own branch (`feat/<short-name>`, or
`fix/<short-name>` for a bug fix) created from `dev`, and lands in `dev`
through a pull request once checks pass. Only @Shaan-Shoukath merges to `main`
(branch protection); never push to `main`. Don't push or delete branches
unless asked. See "Branching" below.

For local review data, `DEMO_PASSWORD=... node --env-file=.env
scripts/seed-demo.mjs` seeds a demo organiser, organisation and event.

## Repository map

| Path | Purpose |
| --- | --- |
| `app/` | App Router pages/layouts, Server Actions, and HTTP route handlers |
| `app/actions/` | Authenticated dashboard and account mutations |
| `components/` | UI grouped by product area; client components are explicit |
| `lib/` | Auth, permissions, validation, RSVP, storage, email, rate limits, and domain services |
| `prisma/` | Prisma schema and ordered migrations |
| `tests/` | Unit, PostgreSQL integration, and Playwright suites |
| `scripts/` | Production checks, schema checks, storage migration, and standalone helpers |
| `charts/spaceworks-events/` | Helm deployment chart: web, worker and beat Deployments and the migration job |
| `deploy/cloudflare-cron/` | Cloudflare Worker that runs the outbox every minute on free hosting |
| `docs/` | Product, security, development, and operational handbook |

## Design system

The UI follows the Space Works brand ([SpaceWorks-Labs/SpaceWorks-Design](https://github.com/SpaceWorks-Labs/SpaceWorks-Design)
is the source of truth; `docs/DESIGN.md` maps it onto this app). Colours come
only from the tokens in `app/styles/tokens.css` via the Tailwind utilities in
`app/globals.css` (`bg-canvas`, `bg-panel`, `bg-primary`, `bg-sidebar`,
`bg-highlight`, `sw-*` brand colours, …); never hard-code hex in components.
Gilroy everywhere, Unbounded (`font-accent`) for one short phrase per public
layout only. Teal for primary actions, Workshop Orange only as a fill with an
ink label (never orange text), Citron sidebar with text-only nav, no shadows on
cards, 44px controls with 10px radius, status pills always carry a word. Logos
come from `components/brand/SpaceWorksLogo.tsx` (masters in
`public/brand/logo/`, never recoloured). Write "Space Works" in copy, never
"SpaceWorks"; no "Oops" or "Something went wrong".

## Working conventions

- Inspect nearby code and existing tests before introducing a pattern. Keep
  changes small, typed, and consistent with the established UI: Tailwind CSS, Radix
  primitives and lucide icons via `components/ui/*` (see `docs/DESIGN.md`).
- Source files (TypeScript, TSX and MJS, tests included) stay at or under 300
  lines, not counting blank lines and comments. ESLint `max-lines` enforces it
  as an error, so CI fails past 300. Split a long module into focused parts
  behind its original import path, as `lib/outbox.ts` re-exports
  `lib/outbox/{payloads,enqueue,context,deliver}.ts`. A "use server" file keeps
  every exported action defined in it (the frontend registry keys actions by
  file and export name): move helpers and schemas into a sibling folder without
  the directive, and if that isn't enough, keep the export as a thin async
  wrapper around a body moved there (see `app/actions/checkin.ts`).
  Generated files (`lib/frontend/registry.ts`, `frontend/catalog.json`) are
  exempt.
- Use Server Components by default. Add `"use client"` only for browser state,
  effects, event handlers, or browser APIs.
- Read the relevant current Next.js 16 guide in `node_modules/next/dist/docs/`
  before changing Next.js APIs, routing, caching/rendering, proxy behaviour,
  Server Actions, metadata, or configuration. This version has breaking
  differences from older Next.js releases.
- Prefer server-side domain helpers in `lib/` over duplicating business rules
  in actions, route handlers, or components.
- Validate all boundary inputs with the existing Zod validators. Return UI-safe
  errors; do not leak internal details.
- Client animations must be restart-safe under React's development
  double-invoked effects (mount, cleanup, mount). With `useAnimate`, do not use
  a one-shot "started" ref guard; give each effect run its own local
  `current` flag, clear it in cleanup, and check it after every awaited step.
- In-process singletons that must be shared across Next.js bundles (Server
  Action vs route-handler copies of a module, such as an `EventEmitter`) live
  on `globalThis` under a `Symbol.for(...)` key, not in module scope.
- Verify CSS or Tailwind changes with a clean build; a stale
  `.next/cache`/Turbopack cache can keep serving old CSS.
- Use the project time-zone and recurrence helpers for dates and series. Avoid
  ad-hoc `Date` parsing or client-only permission decisions.
- Preserve accessibility: use labelled `components/ui` controls, keyboard-operable controls,
  and accessible feedback for async mutation state.

## Security and tenancy rules

- `Organisation` is the tenant boundary. Every dashboard read or mutation must
  resolve the organisation server-side and verify membership plus the required
  `OWNER`/`ADMIN`/`MEMBER` permission. UI visibility is never authorization.
- Organisation staff (any membership role, or an event/series co-organiser
  grant) must use an authenticator app and pass a check each session, at the
  password sign-in or on `/verify-mfa` (`lib/staffMfa.ts`, `lib/mfaProof.ts`).
  Staff checks in actions (`getMembership`, `canAccessEvent`,
  `canViewEventDashboard`) return no access until then, and staff pages
  redirect through `requireStaffMfa`. Attendees and the super admin are exempt.
  Do not bypass these helpers; `STAFF_MFA_REQUIRED=false` is for local
  development and tests only.
- Keep the password sign-in protections in `lib/loginSecurity.ts` (address and
  account failure limits, emailed new-device codes, new-sign-in alerts) and the
  breached-password check in `lib/pwnedPasswords.ts` (sign-up, reset, change).
  Sign-in codes are stored only hashed; only a SHA-256 of a device id is kept.
- Super-admin access is distinct from organisation access. It opens with email
  and password, with no separate authenticator step-up; the super admin's
  password is set only from the server (`scripts/vps-recover.sh`,
  `docker/vps/recover-super-admin.mjs`) and the app refuses its sign-up,
  forgot-password and password changes. Keep its `SUPER_ADMIN_EMAIL` check,
  generic not-found behaviour, and audit coverage intact. Every
  `app/super-admin/**/page.tsx` must call `await requireSuperAdminMfa()` (now a
  super-admin access check only) itself, because layout checks do not re-run on
  client navigation; `tests/unit/super-admin-page-guards.test.ts` enforces it.
  Super-admin insights stay read-only, capped, and parameterised, and never
  load secrets, tokens, answers, or message bodies. Instance-managed SMTP/Google secrets are
  write-only browser inputs, encrypted at rest through the domain-separated
  `MFA_ENCRYPTION_KEY` material, and must never be placed in UI props, logs, or
  audit metadata.
- Server Actions need authentication, authorization, Zod validation, rate
  limiting where applicable, and audit behaviour before mutation. Public RSVP,
  feedback, and search endpoints use route handlers and need equivalent
  protections.
- Preserve event privacy, invite/allowlist checks, capacity transactions,
  duplicate-RSVP protection, ticket eligibility, and feedback anonymity. These
  rules are server-owned and must not be weakened for a UI shortcut.
- Realtime ticket check-in publishes only through `commitCheckInProjection`
  (`lib/checkInMutations.ts` → `lib/ticketCheckInEvents.ts`). Channels are
  keyed by RSVP id, never the ticket token; publishing is best effort and must
  never fail a check-in. `/api/ticket/:token/status` and `/events` return only
  check-in state, validate the token shape, and are rate limited per IP.
- Account self-service stays scoped to the signed-in user: the personal export
  (`/api/exports/account`) returns allow-listed own data only (no secrets or
  tokens), is rate limited, audited, and `no-store`; leaving an organisation
  removes only the caller's membership and blocks the sole owner under a row
  lock.
- Event short codes resolve only for published events with a released
  website, and unknown, unreleased, and rate-limited codes share the
  unknown-organisation 404 so a code never reveals a hidden event's slug.
- Treat ticket, certificate, invite, password-reset, sign-in code, MFA, `CRON_SECRET`, and
  readiness values as secrets/bearer capabilities. Never log, expose, test
  with, or place them in audit metadata, URLs in diagnostics, or analytics.
- Do not read, print, commit, or copy `.env` values. Use `.env.example` for
  variable names and redacted examples. If a credential is exposed in a chat,
  editor, commit, or log, advise rotation rather than repeating it.
- Keep production storage private. Uploaded cover images must continue through
  validation, decode/resize, metadata stripping, WebP re-encoding, and the
  application-controlled delivery route.
- Do not loosen CSP nonces, security headers, trusted proxy-IP handling,
  Server Action origins, Redis fail-closed behaviour, or production TLS checks
  without a documented security and deployment change.

## Data, schema, and background work

- Use Prisma transactions for multi-record state changes, especially RSVP
  capacity/waitlist flows. Rely on database constraints as the final integrity
  layer, not a prior UI check.
- For schema changes, create and review a Prisma migration. Inspect generated
  SQL for indexes, nullability, backfills, constraints, and cascades. Do not
  use `db:push` for deployable changes.
- Keep migration application separate from application startup: production uses
  `npm run db:deploy` as a release/migration job, including the Helm migration
  job where applicable.
- Email is queued in `OutboxMessage`; request paths must not wait for SMTP.
  Preserve safe concurrent claims, retry behaviour, retention cleanup, and the
  worker/beat roles (`SWE_PROCESS_ROLE`, `lib/outboxWorker.ts`) and the
  `POST /api/internal/outbox` recovery path. Beat jobs must stay safe to run
  twice or from two processes at once; they queue email for the worker.
- Sent emails need an absolute `NEXT_PUBLIC_BASE_URL` for links and images;
  dashboard previews render stored paths site-relative. When no public address
  is configured, leave images out rather than sending `localhost` links.
  Organiser values in email designs are escaped and image/link URLs limited to
  absolute http(s).
- Instance settings override legacy environment fallbacks for SMTP, Google SSO,
  and backup posture. Backup settings are display-only; do not imply that the
  app creates, retains, or restores provider backups.
- Organisation webhooks (`lib/webhooks/*`, `docs/WEBHOOKS.md`) are owner/admin
  only. Emit only after a transaction commits, through `emitWebhookEvent`
  (background enqueue, never throws); keep payloads to the strict DTOs (no
  emails, answers, or tokens), signing secrets write-only and encrypted, and
  every target SSRF-checked at save and delivery time with the pinned lookup.
  `WEBHOOKS_ALLOW_PRIVATE_TARGETS` is for development and tests only.
- Machine API clients are tenant-bound bearer identities, not Auth.js users.
  Require explicit scopes, resolve the tenant solely from the credential, use
  explicit DTOs/selects, and never log or persist a raw credential.
- Operational changes must preserve `/api/health` as dependency-free liveness
  and protect `/api/health/db` and `/api/internal/outbox` with their respective
  bearer secrets and generic unauthorized responses.

## Verification

Run the narrowest relevant checks while developing, then proportionate project
checks before handoff:

```bash
npm run lint
npx tsc --noEmit
npm run test:unit
npm run test:integration       # requires disposable local PostgreSQL
npm run build
npm run test:e2e               # routing/auth/public-flow changes
npm run test:e2e:production    # security, headers, auth, tickets, public flows
```

For schema or production configuration work, also run `npm run db:status`,
`npm run db:verify`, and/or `npm run production:check` as applicable. Do not
run integration tests against any non-disposable database. Report checks that
were not run and why.

Other sessions may edit this tree in parallel. Commit with explicit paths, and
do not sweep in or revert other sessions' uncommitted files. The user manual
(`docs/manual/`) is committed only when asked.

### Branching: one branch per feature

Every new feature gets its own branch; never commit a feature straight onto the
integration branch (`dev`). `main` is the production branch Render deploys;
only the maintainer (@Shaan-Shoukath) may merge or push to it, which branch
protection enforces. Never push to `main`; open a pull request instead.

- Branch from the latest `dev`: `git switch -c feat/<short-name>`
  (use `fix/<short-name>` for a standalone bug fix). One feature per branch.
- Commit the work there, with checks passing (lint, TypeScript, relevant tests,
  plus the stronger checks above where they apply).
- Open a pull request into `dev` (or merge locally with `git merge --no-ff`
  when asked), then re-run the checks on the merged result.
- Push the integration branch and the feature branch only when asked. Delete a
  merged feature branch only when asked.
- When other sessions are working in parallel, prefer a separate worktree per
  feature branch (`git worktree add ../spaceworks-events-<short-name> -b feat/<short-name>`)
  so branches don't switch under someone else's uncommitted work.

## Deployment-sensitive changes

- Production requires TLS-backed PostgreSQL, `rediss://`, private S3 storage,
  authenticated SMTP, stable build/runtime Server Action encryption keys, and
  matching HTTPS `AUTH_URL`/`NEXT_PUBLIC_BASE_URL` values. Multiple replicas
  need a shared `REDIS_URL` for live ticket check-in; without Redis the
  in-process fallback only reaches tickets on the same instance.
- Changes to public build-visible variables (including
  `NEXT_PUBLIC_BASE_URL`) require a rebuild. Google SSO is runtime
  instance-managed; do not reintroduce a build-visible feature flag for it.
- A hostname change also needs OAuth callback/origin, DNS/TLS/CDN, cron-service,
  monitoring, and trusted-host review; retain an HTTPS redirect for shared
  event, invitation, ticket, and certificate links.
- Keep `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` stable across all replicas and the
  build. Rotate it only deliberately because outstanding Server Action forms
  will no longer be valid. Never rotate MFA encryption without a seed
  re-encryption plan.
