# Yuyu sync 3, Mentor Desk, judging rounds and the mobile API

Approved by the owner on 27 Oct 2026. Upstream: `yuyu/main` at `8423cd4b`
(https://github.com/twilighty-abhi/yuyu). Ours: `dev` at `eac8c13a`.

Yuyu added 44 commits on 26–27 Oct that `dev` had neither ported nor reviewed.
All of them are taken. The mobile API, deferred in the first two syncs, is
ported too, so a Space Works app can be built later. Two features that Yuyu
does not have are added from the Space Works platform design (the SpaceWorks
repository, `dev`, commits `27b89c6e` and `4c53baa9`): the Mentor Desk with
volunteer shifts, and judging rounds with finalists.

Everything ported or built here has to work with what only Space Works has:
paid events (orders, holds, refunds, promo and access codes, passes, series
date tickets), paid team places and entry fees, prize payouts, event finance
(expense claims, refund requests, budget), the ticket designer, ID badges,
check-in lists, chat notifications, webhooks, staff MFA and the login
protections.

## Status

All merged into `dev` locally (28 Oct 2026); nothing pushed. Released as
**0.11.0** (`CHANGELOG.md`). Migrations run from `20261107020000` to
`20261119030000`; each is described in
[production-operations.md](../production-operations.md#recent-schema-migrations).

| # | Branch | Merge |
| --- | --- | --- |
| 1 | `fix/yuyu-sync-3` | `7fd1af4a` |
| 2 | `feat/hackathon-email-toggles` | `f5aaa088` |
| 3 | `feat/event-crew` | `a10ab52e` |
| — | `fix/event-view-fields` (pre-existing `dev` bugs: event view fields, registration lock, copy) | `50949b2e` |
| 9a | `feat/help-centre` | `6f122083` |
| 5 | `feat/judging-rounds` | `c8d15512` |
| 8a | `feat/mobile-api` (foundation, staff MFA fail-closed, crew endpoints) | `3bc670e7` |
| 6 | `feat/mentor-desk` | `c9b7c6d2` |
| 8b | `feat/mobile-api` phase 8b (judging rounds and Mentor Desk endpoints, idempotent writes) | `e74f745e` |
| 4 | `feat/attendance-confirmation` | `df5a5540` |
| 8c | `feat/mobile-api` review fixes (path-bound idempotency, mentor claim fence) | `ce444f6c` |
| 7 | `feat/volunteer-shifts` | `29f0fe38` |
| 10 | `feat/hackathon-admission` (multi-stage applications, reviewer panels, offers, Accept & pay; added after approval) | `3a12c9b7` |
| 11 | `feat/stage-reimbursements` (reimbursement policies per judging round, mentoring round, admission stage, crew and participants; added after approval) | `734fab21` |
| — | `chore/yuyu-parity` (series-occurrence e2e from Yuyu, migration impact table) | `5925df5c` |
| — | `fix/audit-mentor-desk` | `aeef37b4` |
| — | `fix/audit-judging` | `bc29b347` |
| — | `fix/audit-money-mobile` | `6af8eb4b` |
| — | `fix/audit-admission-privacy` | `b1a3e49a` |
| — | `chore/deploy-hardening` (reserved-address preflight, `db:verify` coverage, 0.11.0) | pending |

- Phase 9b is done: each feature branch added its own guide articles (crew,
  still coming, hackathon email switches, rounds and finalists, the Mentor
  Desk, volunteer shifts, applications, reimbursement policies). No article
  covers the mobile app yet, since there is no app to describe.
- `chore/yuyu-parity` landed Yuyu's series-occurrence e2e test and the full
  migration impact table, including the admission hardening row.

### Final audit (28 Oct 2026, on `dev` at `5925df5c`)

Seven read-only review tracks; no Blockers. Owner decisions taken during the
audit: admission-stage reimbursements pay accepted applicants only (the
`requireAccepted` option is gone); results emails leave crew out; any event
collaborator grant may file their own staff claims on that event.

- **A, decisions and Yuyu** (no upstream commit missing): mobile idempotency
  on every money write, no waiving an applicant's place, per-stage fresh
  eyes, attendance release records an open refund request, no override
  check-in for unaccepted applications, docs (mobile apps not built yet,
  deferrals, the Android fingerprint rename, the Yuyu review list).
- **B, hackathon end to end**: an applicant joining the crew has their
  application withdrawn first; crew stay out of the participant Mentor Desk;
  multi-round results publish only from a finalised final round.
- **C, Mentor Desk**: grant removal fenced by row locks, one lock order for
  help, rounds and visits, eligible visits only, assignment runs refuse
  closed rounds and skip covered teams, mobile conflict and raise-for-team
  routes, documented differences.
- **D, judging**: winners must be final-round finalists, finalised rounds
  freeze their counted reviews, judges can recuse, deletion undo leaves
  opened rounds alone.
- **E, money**: owed desk tickets and paid team leaders cancel through their
  order, a paid solo applicant is one unit on team events, event-first lock
  order on declined team refunds, refund reopen race, no reinstating a
  refunded entry.
- **F, security and privacy**: `JUDGE` collaborators pass the staff
  authenticator check, ticket transfers refused while claims are in play,
  the personal export covers every participation table, secret columns
  forbidden in views, `/order/` kept out of crawlers.
- **G, deploy** (`chore/deploy-hardening`): the reserved-address check runs
  before migrating (VPS updater, Helm migration Job; documented for Render),
  `/order` and `/verify-mfa` reserved too with a test that every top-level
  route is, `db:verify` covers the remaining tables, triggers, keys and
  CHECKs, reimbursement notices queue as bulk email, the CI catalog check,
  operations and configuration notes, and the 0.11.0 changelog and version.

## Branches, in order

Each branch starts from `dev` after the previous one merges. Migrations are
numbered after `20261107010000_ledger_guards`, in branch order. Each ported
commit names its upstream hash on a "cherry picked from Yuyu <hash>" line.

1. **`fix/yuyu-sync-3`**: the upstream fixes.
   - Outbox drain past dropped messages (`22adb522`), plus the outbox part of `bc3171b8`: a time budget, backoff, and transactional email claimed before bulk email.
   - Private, `no-store` signed-in and capability pages, including `/order/{token}`; Redis command deadline; DST-safe event times; schema drift (`ba1fc528`).
   - An unchanged event time keeps its stored value (`56a47332`, web part).
   - Create Event times on the event's clock; Discover overflow (`bb3791e8`).
   - Intl formatter cache, UTC timestamps in raw SQL (including `lib/payments`), Auth.js failure logger, publish row lock (`bc3171b8`).
   - Speaker photo upload (`c8c707b4`), with its own rate-limit bucket. Dashboard tab error boundaries (`88ed91bb`). Event-wide People counts (`cc872878`).
   - Real 404s from dashboard guards (`a11326e4`).
   - Large-event indexes and judging query work (`5a3830bb`). Streaming CSV also covers order, finance and team exports.
2. **`feat/hackathon-email-toggles`** (`c3c83e2f`).
   - The submission receipt and the results email are opt-in per event.
   - Both receipt paths are gated: direct submission, and a project submitted once its entry fee is paid. Payment and refund email is never gated.
3. **`feat/event-crew`** (20 upstream commits).
   - Crew tickets are free and never create orders. They sit outside capacity and payment holds (`seatTakingWhere`, `teamUnits`), never join teams or submissions, and are refused by checkout.
   - A paid registration is never converted into crew.
   - Crew get ID badges, designed tickets, check-in details and a `CREW` expense-claim kind.
4. **`feat/attendance-confirmation`** (`b449c1f5`, `4bf509ef`, `9c722118` and docs).
   - When a guest says No and release is on:
     - **Free registration**: the self-cancel path.
     - **Paid single-ticket order with the buyer replying**: the buyer-cancellation refund policy.
     - **Policy window closed**: a refund request is opened.
     - **Several tickets on the order, or the replier is not the buyer**: nothing is cancelled automatically; organisers are told.
5. **`feat/judging-rounds`** (new).
   - Several rounds per event, each with its own criteria and judge panel.
   - Finalists advance from a closed round; this design is new to Space Works.
   - Finalists are published and emailed.
   - Each existing event's judging becomes one "Main" round and behaves exactly as before.
6. **`feat/mentor-desk`** (new).
   - A `MENTOR` collaborator permission. Mentors pass staff MFA.
   - Mentor profiles and availability.
   - A help queue: lease-based claims, expiry, a beat job, comments and ratings.
   - Mentor–team assignment: manual, round-robin and skill match.
   - Conflicts: a judge who mentored a team is conflicted when the Mentor Desk is on.
   - Office hours, and mentoring rounds with private nominations.
   - Help text never reaches webhooks, chat or audit metadata.
7. **`feat/volunteer-shifts`** (new).
   - Crew kinds, shifts with sign-up and a waitlist, shift check-in and check-out.
   - Hours verified by a second person, then contributor certificates.
   - Hours are never money; reimbursements stay expense claims.
8. **`feat/mobile-api`** (Yuyu's mobile commits plus `b9d1698f`, `c962985c`).
   - First, fix `staffMfaState`, which treats a request without a cookie session as verified.
   - Mobile sessions are request-scoped actors and carry their own MFA proof.
   - Move **dev's** action bodies into `lib/core/*` (never Yuyu's, which lack payments).
   - Add `/api/mobile/v1` with paid RSVP (checkout URL, never confirmed unpaid), orders, receipts, refunds, transfers, claims, entry fees, prizes, check-in lists, desk settlement, crew shifts, the help queue, the mentor console and judging rounds.
   - Ship the OpenAPI contract and a drift test. App links are configured at runtime.
9. **`feat/help-centre`** (`4241db88`, `9adc9c51`, `ad2c2c19`, help parts of `0f0105ff`).
   - `/help` from MDX, generated search index, role-gated sections, screenshots.
   - Rewritten in Space Works wording, with articles for every Space Works-only feature and for 2–8.
   - `docs/manual/` stays as it is.
   - Phase 9a (done on `feat/help-centre`): the guide, the generated index with `--check` in CI and the frontend build, role gating from a view reader, contextual Help links, the disposable-database screenshot pipeline, every upstream article topic rewritten for dev, and new articles for payments, finance, prizes, entry fees, team places, ticket designs, member IDs, chat, organisation email, webhooks, the machine API and VPS installation.
   - Phase 9b (pending, once 2–8 land on `dev`): articles for event crew, attendance confirmation ("still coming"), hackathon email switches, judging rounds, the Mentor Desk, volunteer shifts and the mobile app. That includes Yuyu `9adc9c51`'s `attending/joining-the-crew`, `attending/still-coming`, `guests/attendance-confirmation` and `guests/event-crew`, and its edits to existing articles. `content/help/README.md` says which section file each one goes in.

## Decisions

- Claude builds and reviews every branch, without Codex.
- Mentors must pass the staff authenticator check like other staff.
- `docs/manual/` and the Yuyu PDF are kept.
- Event-page photo uploads get their own rate-limit bucket. The shared `upload` bucket (certificates, member IDs, ticket designs) stays at 12 an hour.
- The mobile app calls the API host directly. Android and Apple app ids and fingerprints are runtime settings, never compiled into the release images.
- The Android App Links fingerprint variable is deliberately named `ANDROID_APP_SHA256_FINGERPRINTS` (Yuyu: `ANDROID_APP_SHA256_CERT_FINGERPRINTS`), matching `ANDROID_APP_PACKAGE_NAME` and `docs/CONFIGURATION.md`. An operator copying a Yuyu `.env` renames it; nothing reads the Yuyu name.
- Each branch merges into `dev` locally once lint, TypeScript, unit and integration tests, the build, the relevant e2e suites and a review pass. The owner checks everything once at the end. Nothing is pushed unless asked.

## Not ported

- Yuyu's release notes, `AGENTS.md` refresh, upgrade runbook and changelog entries. They are Yuyu's own, so each branch writes its own docs instead.
- Yuyu's "kinds added after 1.0" outbox requeue, which is specific to Yuyu's release history.
