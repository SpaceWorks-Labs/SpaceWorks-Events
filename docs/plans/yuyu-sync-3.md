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

## Decisions

- Claude builds and reviews every branch, without Codex.
- Mentors must pass the staff authenticator check like other staff.
- `docs/manual/` and the Yuyu PDF are kept.
- Event-page photo uploads get their own rate-limit bucket. The shared `upload` bucket (certificates, member IDs, ticket designs) stays at 12 an hour.
- The mobile app calls the API host directly. Android and Apple app ids and fingerprints are runtime settings, never compiled into the release images.
- Each branch merges into `dev` locally once lint, TypeScript, unit and integration tests, the build, the relevant e2e suites and a review pass. The owner checks everything once at the end. Nothing is pushed unless asked.

## Not ported

- Yuyu's release notes, `AGENTS.md` refresh, upgrade runbook and changelog entries. They are Yuyu's own, so each branch writes its own docs instead.
- Yuyu's "kinds added after 1.0" outbox requeue, which is specific to Yuyu's release history.
