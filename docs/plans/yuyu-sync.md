# Yuyu sync: what upstream `main` has that `dev` doesn't

Compared 2026-10-21. Upstream: `yuyu/main` at `fd2c94f` (https://github.com/twilighty-abhi/yuyu).
Ours: `origin/dev` at `bdb847c` (PR #35 merged).

## How the comparison was made

- The two repositories share history. `dev` last took Yuyu at the `v1-design-overhaul`
  merge `9eda46c` (16 Oct). `main`'s own merge base is `0b525bd`.
- `git log --no-merges origin/dev..yuyu/main` lists **22 commits** (18–21 Oct) that are
  not in `dev`. Upstream's other branches have nothing new: `v1-design-overhaul` is merged
  into `main`, and `staging` and `feat/short-links` are already in `dev`.
- The rest of the file difference between the two trees is deliberate: the Space Works
  brand and copy, `charts/spaceworks-events` in place of `charts/yuyu`, `release.yml` in
  place of `publish-images.yml`, the paid events work, per-organisation email, the split
  frontend/backend, the VPS installer, and so on.
- To track upstream: the remote is `yuyu` (`git fetch yuyu`). The weekly workflow
  `.github/workflows/yuyu-upstream.yml` opens an issue when upstream has commits `dev`
  doesn't, and CONTRIBUTING.md ("Syncing from Yuyu") describes how to port them.

## 1. Security

| Upstream | What | In `dev`? |
| --- | --- | --- |
| `d48358f` | Next.js 16.3.8 (GHSA-vcvr-r3jv-pc5j, an RCE in `next/og`, plus three more), sanitize-html 2.18.1, sharp 0.35.5, source-map-js 1.2.2; `next typegen` before `tsc` in CI | **Already covered.** `30bd246` and `3785167` did this; `dev` locks next 16.4.2, sanitize-html 2.18.1, sharp 0.35.5 and source-map-js 1.2.2, and CI runs `next typegen`. Nothing to port. |
| `c005b96` | Mobile Google sign-in must name a mobile `azp`; app-link scoping | Only applies to the mobile API (section 4). |

## 2. Bug fixes

| Upstream | What | In `dev`? | Proposal |
| --- | --- | --- | --- |
| `9829c15` | **Publishing from the dashboard didn't release the event's page**, so the event stayed 404 publicly: no sign-ups, and its short link didn't resolve. Status and page release now change in one transaction. | **Bug present** (`publishEvent` in `app/actions/event.ts` only sets `status`). | Port. |
| `214e3ab` | Follow-up: `saveEventPage` creates a missing page released when the event is published, and the data migration `realign_event_publication` repairs events already stuck. | **Bug present** (`isPublished: false` on create). | Port, with the migration renamed to follow `dev`'s latest (`20261031000100_…`). |
| `d377284` | **Instance settings across deployments.** Saved SMTP replaces `SMTP_*` as a whole, so an env service or credentials no longer override a saved host. Blank env values count as unset (so `SMTP_HOST=""` from `.env.example` no longer breaks startup validation). Fields can be cleared. The sender is validated against header injection. Adds **Send test email**. A saved Google ID pairs only with a saved secret. An **unreadable secret** (the key differs or was rotated) disables Google instead of returning 500 on every page, with a named `InstanceSecretUnreadableError`, `scripts/check-instance-secrets.mjs` and an optional Helm migration check. Also: a CI-only TLS bypass for Mailpit, `production:check` no longer needs env SMTP, the super-admin overview uses UTC-safe date windows and gives real top-organisation counts, search and page params are validated, the pager knows when there's a next page, maintenance actions return safe errors, retry resets `attempts`, and the API stats panel is labelled per process. | **Bugs present.** `getEmailSettings`/`getGoogleSsoSettings` still mix the two sources field by field and throw on an unreadable secret. The super-admin invites view reader still loads invite tokens. | Port, adapted: keep `dev`'s per-organisation transports (`lib/email/transporter.ts`) and change only the platform transport. To stay clear of `feat/login-security`, make the Google settings loader itself fail safe (log and return `null`) instead of editing `lib/auth.ts` and the login page. |
| `6c3c4b7` | **Retry failed email** requeues only failures from the last 7 days, so an outage doesn't resend week-old broadcasts. | Present. | Port. |
| `ac64909` | Ops alerts: ignore client-disconnect stream noise. | n/a (needs section 3). | Port with section 3. |
| `a16fba1` | Validator tests used a fixed date that is now in the past. | **Already fine.** `dev`'s fixtures don't use the fixed date. | Nothing. |
| `7918e38` | Mobile: sign-ups can be closed and reopened, a refresh retry gets a grace period, restore is scoped. | Mobile only. | Section 4. |

## 3. Features

| Upstream | What | Fit with Space Works | Proposal |
| --- | --- | --- | --- |
| `db9524d`, `216a88d`, `ac64909` | **Operator alert webhook.** Posts redacted, de-duplicated, rate-capped alerts to a Mattermost/Slack-compatible incoming webhook. The URL is set write-only and encrypted in Super admin → Settings. Covers `onRequestError`, server console errors, Auth.js failures, outbox delivery failures, browser crashes (through a new `/api/client-errors`), and an "instance started" note. One column migration. | Fits. It's instance-level (super-admin only), sends no attendee data, and has nothing to do with organisations or payments. With the split layout, alerts come from the backend; the frontend's error boundaries post to `/api/client-errors`. | Port, except the Auth.js logger hook in `lib/auth.ts` (`feat/login-security` is editing that file). Add the hook in a small follow-up once that branch merges. |
| `945c05b`, `077bf71`, `75d227f`, `15e142a`, `64117fc`, `7918e38`, `c005b96` | **Mobile API** (`/api/mobile/v1`, about 9,000 lines): mobile sessions with rotating refresh tokens, an OpenAPI 3.1 contract with a drift test, attendee registrations and tickets, and organiser day-of work (check-in, guest approval, broadcasts, programme delays, feedback and sign-up state). Universal and app-link files. It first refactors the Server Actions into shared `lib/core/*` functions (check-in, RSVP lifecycle/admin/cancel, broadcasts, account) and moves credential and Google sign-in logic out of `lib/auth.ts`. | **Conflicts on three fronts.** (1) The refactor rewrites the files `dev` has changed most for paid events (`rsvp-lifecycle`, `rsvp-admin`, `rsvp-cancel`, `checkin`). (2) It edits `lib/auth.ts` and the login page, which `feat/login-security` is changing. (3) Its RSVP, cancel, approve and promote routes know nothing about orders, holds or refunds: ported as they are, the app could register someone for a paid event without paying, or cancel a paid ticket without a refund. It also needs a Space Works mobile app to exist (bundle IDs, app-link files). | **Don't port now.** Do it as its own project (`feat/mobile-api`) after `feat/login-security` merges, rebuilding the cores on top of `dev`'s paid-event flows: paid events go through checkout, and cancelling uses the refund path. |

## 4. Tests, CI and docs

| Upstream | What | Proposal |
| --- | --- | --- |
| `b4db91c` | The production e2e step trusts `cf-connecting-ip`, the header the specs send, so browser contexts don't share one sign-in rate limit. | Port. `dev` has the same mismatch: the Quality gate trusts `x-forwarded-for` while the specs send `cf-connecting-ip`. |
| `a2ac77b` | Smoke test: retry refused connections, print container logs on failure, and check that sharp loads in the image. | Port the logs-on-failure and sharp check. `dev` already retries with `--retry-all-errors`. |
| `8a45d80` | Production SMTP tests clear the CI TLS bypass. | Port with `d377284`. |
| `3811915` | A Playwright journey suite for the Yuyu V1 redesign. | **Skip.** It asserts Yuyu's copy and layout, and Space Works has its own design. |
| `b4d2e15` | V1 release documentation refresh. | **Skip as written.** It's Yuyu's release notes. The doc changes for the ported items are made in the same PR. |
| `294ccfa` | Security reports go to a private Mattermost channel, and outside contributions are closed. | **Skip.** That's Yuyu's project policy, not ours. |

## Deliberately different (not ported)

- Yuyu branding, copy, logos (`idlistack-*`), `charts/yuyu`, `publish-images.yml` and the Docker Hub image names.
- Yuyu's "free events only" boundary. `dev` now has paid events.
- Yuyu's `yuyu_v1_` API tokens, `yuyu.` cookies and storage keys, and Redis channels (see `docs/PRODUCTION_RELEASE.md`, "Breaking changes from Yuyu").

## Ported in `feat/yuyu-sync`

The owner approved items 1 to 4 and deferred the mobile API. All of them are ported, each as its own commit naming the upstream hash.

1. **Event publication** (`9829c15`, `214e3ab`), with the repair migration renamed `20261031000100_realign_event_publication`.
2. **Instance settings** (`d377284`, `6c3c4b7`, `8a45d80`). Adapted to `dev`:
   - The platform transport is `getPlatformTransport` in `lib/email/transporter.ts`. Per-organisation sending is unchanged.
   - The fail-safe for an unreadable Google secret is inside `getGoogleSsoSettings`, which `lib/auth.ts` already calls. There is no super-admin authenticator step-up on `dev`, and none is brought back.
   - Upstream's page changes went into `dev`'s view readers (`lib/views/app__super-admin__*`).
   - An organisation that sends through its own server no longer depends on the platform transport being usable.
   - The Settings page's direct test send is `sendSettingsTestEmail`. `dev`'s existing outbox test send on Operations stays.
   - Found while porting: the invites view reader was sending organisation invite tokens to the frontend host. It no longer loads them, and the guard test now checks view readers as well as pages.
3. **Operator alert webhook** (`db9524d`, `ac64909`, `216a88d`), migration `20261031000200_ops_alert_webhook`. Adapted to `dev`:
   - Beat job failures alert too.
   - The webhook column is on the split gateway's forbidden-field list.
   - The settings view reader returns only the webhook host.
   - After `feat/login-security` merged, the Auth.js logger reports sign-in failures with their error type. `dev` already had upstream's login-page copy change.
   - Hardened after review: alert text has mentions, line breaks and backticks neutralised, and runs of 20+ characters redacted (ticket and transfer tokens are 24). Browser crash reports have their own budget of 5 alerts a minute.
4. **CI** (`b4db91c`, `a2ac77b`): both e2e steps trust `cf-connecting-ip`; the smoke test prints container logs on failure and checks that sharp loads.

## Second sync (`feat/yuyu-sync-2`, 22 Oct 2026)

Yuyu added 8 commits on 21 Oct. All were ported except `e668935` (Yuyu's branching policy):

- **Co-organiser permissions** (`b442ae3`, docs `a143721`). One capability object (`lib/eventDashboard/capabilities.ts`) drives the dashboard and its view readers.
  - `MANAGE_REGISTRATIONS` reaches the guest list and RSVP actions through `canManageRegistrationsFor`, matching payment operations.
  - `dev` adds a ticket flag (`EDIT_DETAILS`), and `docs/PERMISSIONS.md` has rows for tickets, payment operations and revenue.
  - The attendee CSV now goes through `canAccessEvent`, so a collaborator also needs a confirmed authenticator.
  - Its e2e spec is ported. It found that the schedule page crashed for every organiser, because `eventForView` dropped `scheduleTracks`; that is fixed.
- **Email drafts with autosave** (`aab425f`, `4133c6f`), with migration `20261102000000_event_broadcast_drafts`. Emails stay owner/admin only.
- **Re-accept a declined registration** (`f05c65a`, tests `50f0f53` and `a4f412b`).
  - A free registration is confirmed, or waitlisted when full.
  - A paid request goes back through the payment flow (`lib/payments/operations/reaccept.ts`): it is offered its places with a payment link, or waitlisted as a request, and is never confirmed without payment.
  - Its e2e spec is ported.

Done from the follow-ups:

- **Alert webhook:** it must resolve to a public address (`lib/opsWebhookAddress.ts`). It is checked on save and before every post, and `OPS_WEBHOOK_ALLOW_PRIVATE=1` allows a LAN chat server.
- **Secrets check:** `scripts/check-instance-secrets.mjs` also checks each organisation's mail server password, chat channel credentials, payment keys and station PINs.
- **Weekly Yuyu check:** it skips commits named on "cherry picked from Yuyu <hash>" lines in `dev` and those listed in `.github/yuyu-reviewed.txt`, and lists each commit once.

## Third sync, branch 1 (`fix/yuyu-sync-3`, 27 Oct 2026)

The upstream fixes from the third sync (plan: `docs/plans/yuyu-sync-3.md`). Every commit names its Yuyu hash; nothing from this branch goes in `.github/yuyu-reviewed.txt`.

- **Outbox** (`22adb522`, outbox part of `bc3171b8`): a pass drains until nothing is due or 40 s have passed, going by how many due messages a batch picked up, and backs off only when a batch failed without a send. Transactional email (including payment notices, member IDs and team email) is claimed before `event-broadcast`, `event-invite` and `results-published`. Yuyu's "kinds added after 1.0" requeue is not ported.
- **Pre-production fixes** (`ba1fc528`). Adapted to `dev`:
  - `private, no-store` for signed-in areas, `/login`, `/join`, `/reset-password`, `/verify-email`, `/verify-mfa`, `/order/{token}`, `/verify/{token}` and any request with the `swe.session-token.v1` cookie, in `lib/pageSecurity.ts` (both proxies). `no-referrer` headers for the order, member ID verification, invitation, reset and email-verification links.
  - `lib/redisOptions.ts`; DST-safe wall-clock parsing for event create/update and series create, plus series schedule items, which `dev`'s schedule form posts as `datetime-local` values. Other date inputs (ticket sale windows, promo and pass validity, judging windows, event sessions) already require ISO instants from their forms.
  - Prisma error log, venue station **Sign in again**, and the schema drift fix (migration `20261107020000_drop_orphan_event_session_type`, CI `prisma migrate diff --exit-code`). `dev` already refreshed the series "N going" count.
  - Not ported: the mobile OpenAPI and catch-all, `ajv` and the `vitest` bump.
- **Unchanged event times** (`56a47332`, web part): a time unchanged to the minute keeps its stored value, so no time-change email. The iOS app-link part goes with the mobile API branch.
- **New event dialog** (`bb3791e8`, dialog part of `bc3171b8`): defaults, `min`, Next and Create on the selected timezone, a controlled picker, focus handling; `/discover` overflow. Own e2e spec `create-event-timezone.spec.ts` instead of Yuyu's redesign journeys.
- **Release-gate fixes** (rest of `bc3171b8`): `lib/format/intlCache.ts` (date and number formatters, including `formatMoney`, revenue and the PDF report); `lib/sqlTimestamp.ts` after an audit of every raw SQL query (judge scoring, webhook claim, the series-date payment lock, processed payment webhooks, every keyset cursor; `lib/payments` row locks, prizes, member IDs and `reserveRsvp` pass no timestamps); `lib/authLogger.ts` treating `dev`'s MfaRequired, EmailVerificationRequired, EmailCodeRequired and TooManyAttempts outcomes as expected; the publish row lock; webhook root-cause errors; table, copy, station gutter, Helm `updateStrategy` and `db:restore --via-local-tunnel`. Already in `dev`: public page section defaults, the absolute robots sitemap, the station "not open yet" message. The submit-receipt wording waits for the hackathon email toggles branch.
- **Speaker photos** (`c8c707b4`): 5 MB browser check, `finally`, toast. Event page images use a new `eventPageUpload` bucket (60 an hour); the shared `upload` bucket stays at 12.
- **Tab error boundaries** (`88ed91bb`), **event-wide People chips** (`cc872878`; attendance counts wait for the attendance branch).
- **Real dashboard 404s** (`a11326e4`): guards are view readers (`lib/views/dashboardGuards.ts`) behind a React `cache` wrapper, so split hosting runs them on the backend. Covers `dev`'s settings chat, email and payments, ticket designs, member IDs and check-in badges. Unit test pins every `loading.tsx`; e2e `dashboard-not-found.spec.ts`.
- **Large events** (`5a3830bb`): migration `20261108000000_large_event_indexes`; aggregated judging reads in `lib/core/judging/judgeWork.ts`; set-based offline roster; gallery search; `csvByteStream` for every export, including orders and Finance. The golden equivalence test is kept as an integration test. Yuyu's `tests/perf` load harness is not ported.

## Follow-ups

- **Mobile API** (`/api/mobile/v1`): its own project, rebuilt on `dev`'s paid-event flows. It is listed as deferred in `.github/yuyu-reviewed.txt`.

Left out on purpose: the redesign e2e suite, and Yuyu's docs and policy commits.
