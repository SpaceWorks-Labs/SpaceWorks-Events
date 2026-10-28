# Architecture

[Documentation index](README.md)

## Stack

- Next.js 16 App Router and React 19
- TypeScript
- PostgreSQL and Prisma ORM
- Auth.js with Prisma persistence
- Tailwind CSS, Radix UI primitives and lucide icons (`components/ui/*`)
- Redis for distributed rate limiting and realtime ticket check-in pub/sub
- S3-compatible private object storage
- Nodemailer-backed transactional email
- Vitest and Playwright

## Repository layout

| Path | Responsibility |
| --- | --- |
| `app/` | Pages, layouts, Server Actions, and route handlers |
| `components/` | Client and server UI components grouped by product area |
| `lib/` | Authentication, authorization, validation, RSVP logic, storage, email, rate limiting, and shared services |
| `prisma/` | Data model and ordered production migrations |
| `scripts/` | Environment, schema, asset migration, and standalone-build helpers |
| `tests/` | Unit, PostgreSQL integration, and browser suites |
| `content/help/` | The in-app guide at `/help`: MDX articles, the section manifest, and generated indexes |
| `docs/` | Product and operational documentation |

## Request flow

```text
Browser / API client
        |
        v
Next.js proxy: rate limits + CSP nonce
        |
        +--> React Server Component / Server Action
        |          |
        |          +--> Auth.js session + permission checks
        |          +--> Zod validation
        |          +--> Prisma transaction
        |
        +--> Route handler
                   |
                   +--> monitoring + rate limit + validation
                   +--> domain service + Prisma
```

Server Actions are used for authenticated dashboard mutations. Public RSVP and feedback submissions use JSON route handlers. Authorization belongs on the server even when the UI hides an unavailable control.

External applications authenticate under `/api/v1` with tenant-bound `ApiClient` credentials rather than Auth.js sessions. A route wrapper resolves the client organisation and scopes, then passes that context to explicit domain readers. Queries include the organisation predicate and responses are mapped through validated API DTOs rather than serialized Prisma models.

## Multi-tenancy and authorization

`Organisation` is the tenant boundary. Events, series, invitations, assets, and audit events resolve through an organisation. `Membership` connects a user to a tenant with an owner, admin, or member role. Permission helpers and action-specific checks enforce access before mutation.

Organisation staff (any membership or event/series co-organiser grant) must also pass an authenticator check in the current session (`lib/staffMfa.ts`). Staff pages redirect to `/account/security?mfa=required` or `/verify-mfa`, and the staff checks in actions (`getMembership`, `canAccessEvent`, `canViewEventDashboard`) return no access until then. The check is either a TOTP code at the password sign-in (carried in the session token) or the signed `swe.mfa-proof.v1` cookie set by `/verify-mfa` (`lib/mfaProof.ts`). Password sign-in protections (address and account failure limits, emailed new-device codes, new-sign-in alerts) live in `lib/loginSecurity.ts`; the breached-password check in `lib/pwnedPasswords.ts`.

The super-admin boundary is separate: access requires an authenticated email matching `SUPER_ADMIN_EMAIL`, and unauthorized requests behave as not found.

## Main data areas

- Identity: `User`, `Account`, `Session`, `VerificationToken` (also holds hashed sign-in codes), and `UserDevice` (a SHA-256 of each browser's random id, a short browser description, and the last IP).
- Tenancy: `Organisation`, `Membership`, and `OrganisationInvite`.
- Events: `Event` (including `listedPublicly` for listed approval-required events and an optional unique `shortCode`), `EventInvite`, `EventSeries`, `SeriesInvite`, and `EventInstance`.
- Registration: `RSVP`, registration forms, fields (with help text, placeholder, and validated `settings` JSON), and typed answers.
- Teams: `Event.registrationMode`, `teamMinSize`, `teamMaxSize` and `soloPolicy`; `Team` (status mirroring every member RSVP, unique per-event `nameKey`, join token, SHA-256 `manageTokenHash`, leader RSVP); `RSVP.teamId`; `TeamSeekerProfile` for solo registrants looking for a team; and `TeamJoinRequest` invitations and requests, at most one pending per team and RSVP. See [Team registration](TEAMS.md).
- Hackathon judging: `Event.submissionsEnabled`, `submissionsOpenAt`/`submissionsCloseAt`, `judgingStatus`, `judgesSeeAll`, `projectGalleryPublic` and `resultsPublishedAt`; `Submission` (exactly one of a unique `teamId` or `rsvpId`, enforced by a CHECK constraint, cascading with its team or RSVP); `SubmissionLink` (one SHA-256 token hash per solo RSVP); `JudgingCriterion` (per round); `JudgeAssignment` (unique per round, judge, and submission; `recusedAt` when the judge recused); `JudgeScore` (unique per submission, judge, and criterion; a score belongs to its criterion's round) and `JudgeReview` (unique per round, submission, and judge); judging rounds: `JudgingRound` (position, status, entry source, panel, fresh eyes, target, score method, `finalizedAt` and `countedFrozenAt`), `JudgingRoundEntry` (finalists advanced into an ADVANCED round), `JudgingRoundJudge` (a round's panel), `JudgingAssignmentRun` (automatic assignment runs), `JudgingFinalistNotice` (who was emailed about a round's finalists) and `JudgingRoundCountedReview` (the reviews a finalised round counted); `EventAward` and `EventAwardWinner` (unique per award and place, and per award and submission); and the `JUDGE` value of `EventPermission`. See [Hackathon submissions, judging, and results](HACKATHON.md).
- Communications: `EventBroadcast` records each organiser email, including its chosen `design`; each recipient is a separate `OutboxMessage`. `EventBroadcastDraft` holds one organiser's unsent Emails-tab composer per event (unique on event and user, private to that user, cascading with both); the dashboard send deletes it in the send transaction. The draft actions (`app/actions/broadcasts.ts`, bodies in `app/actions/broadcasts/drafts.ts`) share the send's access check, and the Emails view reads the draft through the same helper.
- Feedback: feedback forms, fields, responses, typed answers, and optional certificate linkage.
- Operations: `OutboxMessage`, `OperationalHeartbeat`, `AuditEvent`, `CheckInEvent`, `RsvpDeletionUndo`, and `Asset`.
- Check-in lists: `CheckInList` (per standalone event: `name`, `sortOrder`, `archived`, `requiresEntryCheckIn`; names unique per event among non-archived lists, ignoring case, through the partial index `CheckInList_eventId_active_name_key`), `CheckInListRecord` (one guest in one list: list, RSVP, actor, `checkedInAt`, `source` of `online`/`mobile-scan`/`mobile-manual`; unique on `listId`, `rsvpId`; undo deletes it), and the immutable `CheckInListEvent` history (`CHECKED_IN`/`CHECK_IN_UNDONE`). Deleting the event removes all three; deleting an RSVP removes its records and detaches its history (`rsvpId` set to null, like `CheckInEvent`); deleting a user nulls the actor. List history is a separate table rather than more `CheckInEvent` actions so that entry reports and check-in source counts never pick up list activity. `commitListCheckIn` (`lib/checkInListMutations.ts`) locks the RSVP row and share-locks the list, applies `gateListCheckIn` (`lib/checkInLists.ts`, which reuses the entry gate) and writes the record and history in one transaction; it never touches `RSVP.checkedInAt`, `CheckInEvent` or the realtime ticket channel. Removing a guest with undo keeps their list records in the undo snapshot and restores them.
- Instance administration: the singleton `InstanceSetting` holds the new-account policy plus encrypted SMTP and Google SSO secrets and non-secret backup posture. It is readable and mutable only through the super-admin boundary.
- Machine access: `ApiClient`, `ApiClientScope`, and hashed, rotatable `ApiCredential` records.
- Outgoing webhooks: `WebhookEndpoint` (per organisation, at most 10; URL, subscribed event types, encrypted signing secret, enabled/auto-disabled state and failure counter) and `WebhookDelivery` (the durable queue and delivery log, one row per endpoint and event, unique on `endpointId`/`eventId`). See [Organisation webhooks](WEBHOOKS.md).

### Team registration and capacity units

On a `TEAM` event `Event.capacity` counts units: each team and each solo RSVP is one unit. Every path that changes capacity (`reserveRsvp` in `lib/rsvpCore.ts`, `lib/rsvpCapacity.ts`, cancellation, organiser delete and restore, the capacity check in `updateEvent`) and every team mutation in `lib/core/teams.ts` takes the same `SELECT ... FOR UPDATE` lock on the `Event` row first, then counts with `countConfirmedUnits` (`lib/teamUnits.ts`). `INDIVIDUAL` events keep the plain confirmed-RSVP query. Team status changes update the `Team` row with a conditional `updateMany` guarded by the expected status and move every member RSVP in the same transaction, so each member's status always equals the team's. A team id from the browser is always re-read with its `eventId`, and leader authority (a management-token hash or the signed-in leader) is re-checked under the lock. Server Actions in `app/actions/teams.ts` and `app/actions/team-admin.ts` authenticate, rate limit, audit, and revalidate around these cores. The `team-created` and `team-member-added` outbox kinds carry capabilities and are deleted after delivery.
### Event crew

`lib/admission/*` owns applications ([Applications and shortlisting](ADMISSION.md)): database triggers make an `AdmissionApplication` with each registration on an admission event and refuse a confirmed or held place without an offer; the cores lock the `Event` row, then registrations, then any order, like every registration and payment path. `app/actions/admission.ts` and `app/actions/admission-applicant.ts` authenticate, rate limit and revalidate around them; the beat runs `runAdmissionMaintenance`.

`lib/core/crew.ts` (parts in `lib/core/crew/`) owns the crew ([Event crew](CREW.md)); `app/actions/crew.ts` authenticates, rate limits, audits, and revalidates around it. Each crew member owns one free `CONFIRMED` RSVP with `isCrew` (database CHECK `RSVP_crew_shape`: event-bound, no team, no order, no ticket type). Adding a member takes the same `Event` row lock as capacity and payment changes, so converting a free solo registration cannot interleave with a registration; a place it frees is offered to the waitlist after the commit. Every capacity and seat-hold count spreads `takesCapacity` through `seatTakingWhere` (`lib/payments/holds.ts`) or `countConfirmedUnits` (`lib/teamUnits.ts`), so crew are confirmed but never use a place. Registration, checkout and transfers refuse an email already on the crew (`hasCrewEmail`). The crew ticket email is its own transactional outbox kind (`crew-ticket`, `lib/outbox/crew.ts`).

### Hackathon judging

`lib/core/judging.ts` owns every submission, judging, and results rule; Server Actions (`app/actions/submissions.ts`, `app/actions/judging.ts`, `app/actions/judging-admin.ts`), the pages, and `GET /api/exports/events/:eventId/judging` authenticate, rate limit, and revalidate around it. Entrant authority is an `EntrantAuth` proof (a team management-token hash, a signed-in team member, the signed-in owner of a solo RSVP, or a submission-link hash) re-checked inside the write transaction. Entrant and judge writes take `FOR SHARE` on the `Event` row (entrants then lock their `Team` or `RSVP` row, so one entrant's writes serialise); organiser changes take `FOR UPDATE`. Closing the window, freezing the rubric, or closing judging therefore serialises with in-flight saves, and the window is compared with server time inside the transaction. Score and review writes are `INSERT ... ON CONFLICT` upserts on their unique keys.

`lib/judgingAccess.ts` resolves the two roles from the organisation slug: *can judge* (organisation owner/admin or a `JUDGE` grant on that event) and *can manage judging* (owner/admin only). `JUDGE` never satisfies another `canAccessEvent` permission, a judge-only collaborator sees only the judging workspace on the dashboard (`isJudgeOnly`). Judges never see an entrant whose RSVP their own account owns. Result scores are pure functions in `lib/judgingScore.ts`; public, judge, entrant, and organiser views go through `lib/judgingDto.ts`. The public results and gallery pages first apply the event page's access rules (`lib/publicJudgingPage.ts`, built on `resolvePublicEventAccess`) and only then call the loaders. The entrant pages (`/submit/:token`, `/account/submissions/:eventId`, the team page section, and the ticket card) are capability pages like the ticket and team pages: the entrant proof stands in for the invite list, but they exist only while the event is `PUBLISHED` and its website released (`loadEntrantSubmission`). The `submission-received`, `submission-link` (a capability, deleted after delivery), and `results-published` outbox kinds deliver the emails; the core writes the spec's audit events in the same transaction as each change.


Refer to `prisma/schema.prisma` for the authoritative fields, constraints, indexes, and cascading behavior.

## Background and scheduled work

Request handlers enqueue transactional messages in `OutboxMessage`; they do not wait for SMTP delivery. `lib/outbox.ts` is a facade over `lib/outbox/` (`payloads`, `enqueue`, `context`, `deliver`). Background work runs in two roles, both in `lib/outboxWorker.ts` and selected per process by `SWE_PROCESS_ROLE`:

- The **worker** polls the outbox every `OUTBOX_POLL_MS` (default 3 seconds), claims and sends batches of 50 until nothing is due or 40 seconds have passed, and retries failures. Transactional email (sign-in codes, password resets, tickets, payment receipts, team email) is claimed before the bulk kinds (`event-broadcast`, `event-invite`, `results-published`), so a large send never delays it. A batch that failed without a single send ends the pass, so a mail-server outage does not burn through the retry schedule of the whole queue. It records the `outbox-scheduler` heartbeat.
- The **beat** checks every 15 seconds which timed jobs are due and runs them: payment maintenance (hold expiry, refunds, payment-link reminders) and waitlist filling every minute, event reminders (a day before each event or series date, once per guest) and backup alerts every 5 minutes, organisation webhook delivery every 15 seconds, and the retention purge every hour. Its jobs queue email for the worker. It records the `beat` heartbeat.
- Organisation webhooks (`lib/webhooks/delivery.ts`, run by the beat): rows are claimed with `FOR UPDATE SKIP LOCKED`, posted with a pinned, SSRF-checked connection, retried with jittered backoff (8 attempts over about a day), and a failing endpoint is switched off after 20 consecutive failures; a webhook failure never fails another job. Webhook events are emitted at the commit points (`reserveRsvp` in `lib/rsvpCore/reserve.ts`, `confirmRsvpWithinCapacity`, the RSVP lifecycle, cancel and admin actions, `commitCheckInProjection` and `commitUndoCheckInProjection`, the event create, update, publish and cancel actions, `submitFeedback`, and the payment paths that change a registration) after their transactions commit, through `emitWebhookEvent` (`lib/webhooks/emit.ts`), which only inserts queue rows in the background and never throws.

With the default role, `all`, one process serves requests and runs both loops, as the Render free instance does. The VPS stack and the Helm chart run `web` containers that only serve requests, beside separate `worker` and `beat` containers from the same backend image. Queue row claims keep concurrent workers safe, and every timed job is safe to run twice. Heartbeats live in `OperationalHeartbeat`; the super-admin Operations page treats either as stale after 3 minutes. The protected `POST /api/internal/outbox` endpoint runs every timed job once and then drains the queue, for cron services (the Cloudflare Worker on free hosting) and manual recovery.

## Realtime ticket check-in

When an RSVP transitions to checked in, `commitCheckInProjection` (`lib/checkInMutations.ts`, the single write path for online scans, manual check-in, offline-sync replay, and venue stations) publishes a `checkedInAt` message after its transaction commits through `lib/ticketCheckInEvents.ts`. Channels are keyed by RSVP id, never by the ticket token. With `REDIS_URL` set, messages fan out to every replica over Redis pub/sub (one lazily created subscriber connection per process, reference-counted per channel); without Redis an in-process EventEmitter shared through `globalThis` is used (Next.js can load the module more than once per process, for example in separate Server Action and route-handler bundles), which only reaches viewers on the same instance. Production requires `REDIS_URL`, so multi-replica deployments always use pub/sub. Publishing is fire-and-forget and never fails a check-in. The ticket page listens via `GET /api/ticket/:token/events` (SSE) and can fall back to `GET /api/ticket/:token/status`; both return only the check-in state. Delivery is best effort: while the stream is open the client also re-reads the status every 15 seconds, and a dropped message is recovered on that check, the next reconnect, or a return to the tab. Status and stream requests are rate limited per client IP (`ticketStatus`, `ticketEvents`), and each process caps open ticket streams. Reverse proxies must not buffer `text/event-stream` responses: the route sends `X-Accel-Buffering: no`, and nginx-style proxies should also set `proxy_buffering off` for `/api/ticket/`. Allow idle reads of at least 30 seconds (the stream sends a ping every 25 seconds and closes after 10 minutes).

## Instance service configuration

The super admin can configure SMTP, Google SSO, backup posture, and an operational alerts webhook (`lib/opsAlerts.ts`, fed by `instrumentation.ts`) at `/super-admin/settings`. These are read from PostgreSQL per send or sign-in; every process that serves requests or runs the worker or beat forwards its own alerts. Instance-managed values take precedence over legacy environment fallbacks. SMTP and Google client secrets are encrypted at rest with an AES-GCM key domain-separated from `MFA_ENCRYPTION_KEY`; the application never renders stored secrets back to the browser. Backup posture is display-only—backup execution, encryption, retention enforcement, and restore access remain infrastructure responsibilities.

## Storage

Asset metadata lives in PostgreSQL. Production file bytes live in a private S3-compatible bucket and are served through the application-controlled upload route. Local development can retain database blobs as a fallback. Production startup requires S3 configuration.

## In-app guide

The guide at `/help` renders MDX from `content/help` through `@next/mdx` (`mdx-components.tsx`, `components/help/mdx.tsx`). Section order, titles, summaries and each section's audience live in `content/help/sections/*.ts`. `scripts/generate-help-index.mjs` writes `content/help/index.generated.ts` (headings and plain-text search sections, compiled with the same helpers as the pages, `lib/help/text.ts`) and `content/help/bodies.generated.ts` (one static import per article), so nothing reads files at runtime and the split frontend renders the guide from its copy of `content/help`; `--check` runs in CI and in the frontend build. Which sections a visitor sees comes from the view reader `loadHelpAccess` (`lib/views/app__help__layout.ts`, cached per request by `lib/help/access.ts`): owners and admins of any organisation add `org-admin`, the super admin adds everything. It is a reading convenience and never authorizes a feature. Search loads `GET /api/help/search-index` (`private, no-store`) and ranks in the browser. Screens link to articles with `components/help/HelpLink.tsx`, whose `article` is typed against the manifest.

## Security headers and rendering

The proxy generates a fresh Content Security Policy nonce for application-page requests. The root layout waits for a real request so Next.js can attach the nonce to framework scripts. Other response headers include HSTS in production, frame denial, content-type protection, a restricted permissions policy, and a strict referrer policy.

This per-request nonce makes application pages dynamically rendered. There is deliberately no root `app/loading.tsx`: a root Suspense boundary would stream a 200 before `notFound()` or `redirect()` run, breaking real 404s and the short-link 307. Dashboard loading screens are scoped with route groups (`(home)`, `(overview)`, `(general)`, `(list)`) and each sits below a layout that awaits the wrapped page's access check first (`lib/dashboardGuards.ts`, a React `cache` over the view readers in `lib/views/dashboardGuards.ts`), so refusals stay real 404/307 responses; `tests/unit/dashboard-loading-boundaries.test.ts` pins where they may live. Static metadata endpoints such as `robots.txt` and `sitemap.xml` remain static.

## Deployment shape

`next.config.ts` produces standalone output. The Docker image copies the standalone server, public assets, static chunks, and Prisma migrations into a non-root runtime image. PostgreSQL, Redis, S3, SMTP, TLS termination, monitoring, and backup services are separate production dependencies. The [single-VPS Compose stack](DEPLOYMENT_VPS.md) bundles PostgreSQL, Redis, private Silo storage and Caddy alongside the application, its email worker and its beat; SMTP delivery, monitoring and off-server backup/PITR remain operator-managed. The default deployment shares one Next.js runtime. The [split deployment](DEPLOYMENT_SPLIT.md) builds a separate rendering workspace for Netlify; guarded view readers, authentication persistence, domain actions, HTTP APIs and jobs run on the VPS.


### Separate rendering workspace

`lib/views/` owns guarded page/panel readers; existing pages render their DTOs.
`scripts/generate-frontend-catalog.mjs` creates the fixed registry of those readers
and existing `app/actions` exports. `scripts/prepare-frontend.mjs` builds the ignored
`frontend/app`, `components`, `lib` and `public` trees from shared sources, replacing
readers/actions with typed server gateway calls. Edit shared sources and generator
templates, never generated copies. CI/build verifies the catalog is current and
audits frontend dependency traces to reject Prisma engines, Redis, SMTP and S3.

The backend peer route authenticates a 32-byte service credential and exact
frontend Origin, accepts bounded tagged data, and dispatches only explicit registry
entries. Every reader/action still checks the user's cookie-backed identity and
permissions. Panel readers reload permissions from org slug/event id; forwarded
permission claims are rejected. Views use explicit selects/DTOs and reject known
secret fields. Dates, maps, sets, files and duplicate FormData values retain their
types; functions and class instances cannot cross the wire. The action response
carries local navigation, host-only cookies and request-scoped invalidations to
the frontend. Cookie/sign-in HTTP handlers proxy through the frontend origin.

Only an authenticated peer may forward the platform-verified browser IP. Backend
Caddy overwrites its ordinary client-IP header. Public proxy callers cannot reach
peer, scheduler or readiness endpoints, including encoded path variants. All
calls fail closed on gateway/rate-limit failures. Ticket SSE uses its bearer URL
directly at the VPS with exact frontend-origin CORS and the existing state-only
projection; frontend polling remains the fallback.
