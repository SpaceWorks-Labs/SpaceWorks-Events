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

The in-app guide is covered by `help-content` (every manifest entry has an MDX file and back, slugs stay in their section, articles use only the allowed components and no `#` title, links and anchors resolve and public articles never link to restricted ones, every screenshot is captured, every `HelpLink` in `app/` and `components/` points at a real article and section, and the generated index is current), `help-text` (anchors, headings, search text and ranking, and the generator's `--check` on a temporary content folder), `help-access` (who sees which sections, restricted articles, the `private, no-store` search index, and `no-store` for signed-in guide pages) and `help-screens-guard` (the screenshot seed's disposable-database guard).

Custom check-in lists are covered by `event-capabilities` (including the check-in list flags), `check-in-lists` (list schemas, the list eligibility gate reusing the entry gate, the duplicate message and eligible counts) and `attendee-export-route` (including the per-list CSV columns).

Organisation webhooks are covered by `webhooks` (signature against a fixed HMAC vector and verification, whsec_ secret shape, domain-separated secret encryption, every blocked IPv4/IPv6 range including IPv4-mapped, NAT64 and 6to4 forms, decimal/hex/octal IP literals, `localhost.` and internal names, ports and URL credentials, the dev/test flag never honoured in production, DNS answers with any private address, pinned lookup, host-only audit labels, payload DTO forbidden-field regression, and the retry schedule with jitter), `production-check-script` (refuses `WEBHOOKS_ALLOW_PRIVATE_TARGETS`), `retention` and `outbox-worker` (webhook purge and delivery in the scheduler pass), and `migration-safety`.

Event crew ([CREW.md](CREW.md), conditions in [CREW_TEST_CONDITIONS.md](CREW_TEST_CONDITIONS.md)) is covered by the `crew` unit suite (crew profile and organiser schemas: trimming, lowercase email, limits, `http(s)`-only LinkedIn URLs, upload-only photos, unknown keys refused; join token shape and path; the food-preference summary; `hasCrewEmail`), `crew-email` (crew ticket wording, escaping, designed ticket attachment), `crew-outbox` (the `crew-ticket` kind: transactional, a capability, strict payload, dropped for a removed member, a cancelled event or another organisation), `crew-migration` (additive SQL, the `RSVP_crew_shape` CHECK, the schema verifier), `crew-surfaces` (no-store, robots, reserved slug, desk details, badge filters, role and same-organisation photo, the page section note), and crew expectations in `team-units`, `rsvpCapacity`, `paid-ticket-helpers`, `event-page-summary`, `event-capabilities` (`canManageCrew`), `webhooks` (`crew` in the registration DTO) and `upload-rate-limits` (`crewPhotoUpload`).

Volunteer shifts ([VOLUNTEERS.md](VOLUNTEERS.md)) are covered by `volunteer-math` (counted minutes less breaks, refused intervals and breaks, half-open overlaps, the check-in and duty windows, places, hour labels, the `{{role}}` and `{{hours}}` merge tags, crew kind labels), `volunteer-outbox` (the `volunteer-notice` kind: transactional, a capability, strict payload, dropped when the place, member, certificate or organisation no longer matches), crew kind expectations in `crew` (organiser schema kind, public form refuses it) and the `VOLUNTEER_HOURS_EXPORTED` audit action in `super-admin-insights`.

Team registration unit suites are `team-validators` (event team settings, series refusal, team names, registration intents, seeker limits), `team-units` (unit counting, oldest-unit promotion, leadership handover), `team-token` (token shape and SHA-256 storage), `team-dto` (join page and seeker list never expose member names, emails, answers, or tickets), `team-outbox` (the `team-created` and `team-member-added` kinds, dropped when the link was retired), and `guest-list-teams` (the Guests list "In a team" and "Solo" filters and team-name search).
Hackathon judging unit suites are `judging-validators` (submission content with `https:`-only links checked by `URL`, settings, rubric, awards, scores, and reviews), `judging-score` (the result-score formula, one-decimal rounding, and shared tie ranks), `judging-dto` (public results, gallery, judge, and entrant views never expose emails, answers, tickets, scores, comments, or disqualification reasons), `judging-outbox` (the `submission-received`, `submission-link`, and `results-published` kinds; the link token is a capability), `hackathon-emails` (the opt-in results and receipt emails: defaults, gating, announcement states, dialog copy, the optional switches, the submit confirmation), `judging-admin-emails` (the switches through `saveJudgingSettings` and Send results email now for owners and admins only), `judging-permissions` (JUDGE opens only the judging workspace; judge-only detection), `judging-advancement`, `judging-assignment-random` and `judging-rounds-copy` (rounds: finalist plans, seeded assignment, copy), `event-collaborator-actions` (JUDGE grants, never on a series), `submission-actions` (how the team page, account, and submission link reference a project; audit; the ticket page's link request), `submission-account` (projects in the personal data export and the Account → Registrations link), `judge-workspace` (judge progress and score inputs), and `project-links` (public project links).


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

| `crew.db.test.ts` | Event crew ([CREW.md](CREW.md)): a free confirmed `isCrew` ticket and `crew-ticket` email per member; crew outside capacity on individual and TEAM events and in the dashboard counts; converting a free solo or waitlisted registration keeps its token and offers the freed place to the waitlist; a team member and a project entrant are refused; duplicate emails; profile edit with a new address emailed once and crew clashes named; reorder; removal once; cascade; the `RSVP_crew_shape` CHECK (status, team, ticket type); the public list without private fields |
| `crew-link.db.test.ts` | The crew sign-up link: create/keep/rotate/disable, hidden link sign-ups with a ticket and a chat notice, no enumeration for crew or registered emails, never converting a registration, cancelled and ended events refused, field limits, foreign crew photos, the 500-member cap, and another organisation's context reaching nothing |
| `crew-guards.db.test.ts` | Self-cancel and Guests · People edit, remove, approve and decline refused for crew; registration and guest-email changes to a crew email refused; team join and organiser move refused; crew never hackathon entrants; Account → Registrations wording; designed ticket values; only owners, admins and `MANAGE_REGISTRATIONS` manage the crew (being crew grants nothing); the reserved slug |
| `volunteer-signups.db.test.ts` | Volunteer shifts ([VOLUNTEERS.md](VOLUNTEERS.md)): six concurrent sign-ups for two places give exactly two and leave nothing behind; concurrent withdrawals on two shifts with crossed waitlists both succeed and promote (no deadlock); the waitlist is promoted first in, first out, skipping someone now on an overlapping shift, with `promoted` email; overlapping approvals refused, back-to-back allowed; declined stays declined, withdrawn may re-apply; deadline, started and shifts-off refusals; more places promote, places never below approved; organiser cancel and shift delete send `cancelled` |
| `volunteer-hours.db.test.ts` | Shift attendance and hours: self check-in only inside the grace window and never on another person's sign-up, one active duty, pending hours at check-out, event check-in untouched; desk times need a reason (kept as corrections), overlapping counted time and over-long breaks refused, no-show after the end; verification by a second owner/admin only (linked account and email both refused, members refused, adjust needs verify first, a reason and ≤ 1440); the database refuses an entry by the volunteer, entry update/delete, hours changes without an entry, direct hours delete and correction delete, while crew removal and event deletion still cascade |
| `volunteer-certificates.db.test.ts` | Contributor certificates: verified minutes above zero needed (pending hours and role labels prove nothing), owner/admin only, `certificate` email, role/minutes snapshot and download view; adjusting hours revokes the certificate and the download, one live certificate (partial unique index), revoke; the MENTOR kind alone is not evidence, and never to oneself; design images must be the organisation's own |
| `volunteer-followups.db.test.ts` | Review follow-ups: an organiser who moves their own crew ticket to another email stays linked and still cannot verify their hours or issue their certificate, and verified hours freeze the email; only verified accounts are linked and mobile reaches a linked ticket only while the emails match; two concurrent check-ins give one, a no-show is never written twice, desk commands stop when shifts are off; a shift edit that would overlap two volunteers' places is refused with the count; hours inserts must be pending at version 0 with the counted minutes (trigger); a mentoring certificate whose evidence is gone stops downloading, is revoked by the recheck and is replaced on reissue |
| `volunteer-mentoring.db.test.ts` | Mentor Desk links: only an activated assignment under a current MENTOR grant counts as mentoring evidence (a proposal or the MENTOR kind alone does not); ending the grant revokes the mentoring-only certificate and its download; a mentor's new crew place gets kind MENTOR and the account link, and an existing crew place is linked but keeps its kind |
| `mobile-api-volunteers.db.test.ts` | Volunteer shifts on mobile: own shifts only through a linked crew ticket (others 404, signed out 401); apply, check-in, check-out and an unknown action 404; the roster for a MANAGE_REGISTRATIONS co-organiser without emails, other organisations and strangers 404; approve, a desk time without a reason refused; hours verify FORBIDDEN for the co-organiser and allowed for the owner, adjust needs a reason |
| `volunteer-permissions.db.test.ts` | Who acts on shifts: an `ORGANISER`-kind crew member with an account gets no organiser action; a `MANAGE_REGISTRATIONS` co-organiser runs shifts (audited) but cannot verify or issue, `CHECK_IN` alone cannot; another organisation is refused; crew-ticket actions need the ticket's own account when it has one and stop when shifts are off; link sign-ups take the link's kind; accepting a collaborator invitation links the crew record to the account |
| `reimbursements-claims.db.test.ts` | Reimbursement policies ([FINANCE.md](FINANCE.md)) on a free event: cap per person per policy separate from other policies and general claims, the policy budget never overspent by five concurrent claims, window, active switch and confirmed status, crew-only policies, the frozen snapshot surviving a policy edit, approval refused after a check-in is undone and allowed again, approval within the current budget, general claims unchanged, and the mobile reimbursements and organiser policy list |
| `reimbursements-eligibility.db.test.ts` | Judging-round finalists (team and solo, finalists-published switch, other teams refused, a disqualification blocking approval) and mentoring-round teams (away, unvisited, solo and crew refused); the once-per-person `reimbursement-available` beat run concurrently, payloads without ticket tokens, and delivery dropped once the policy closes |
| `reimbursements-admin.db.test.ts` | Policies managed only by owners and admins of the event's own organisation; the stage matched to the kind and event in code and by CHECK and trigger; a claim's policy in the claim's event; who a policy is for fixed once claimed; close instead of delete; a used judging round not deletable; event deletion keeping claims and organisation deletion with policies |
| `reimbursements-admission.db.test.ts` | Admission-stage policies ([ADMISSION.md](ADMISSION.md)): team members through the team's application and solo applicants who reached the stage qualify, those still at an earlier stage don't, waitlisted applicants only without *Only accepted applications*, a withdrawn application refused at the ticket page and at approval; the stage kept to the policy's event and to events taking applications (in code, CHECK and trigger); a stage a policy is for can't be deleted |
| `crew-paid.db.test.ts` | Crew with payments and finance: no order for crew, a paid buyer's held seat is the only place with crew present, checkout and transfers refuse a crew email, bought, held and free-ticket orders never convert to crew, and crew claims (`CREW`, no cap) only with `crewClaimsEnabled` |
| `teams.db.test.ts` | Team registration: unchanged `INDIVIDUAL` events, `TEAM_REQUIRED`, case-insensitive team names, concurrent team creation for the last unit, concurrent joins against `teamMaxSize`, atomic whole-team approval (refused below `teamMinSize`), no joins into rejected teams, seeker acceptance freeing a unit and promoting the oldest waitlisted unit, cross-event and cross-organisation team ids, a management token used against another team, leadership handover on leader cancel, disband promotion, organiser move/remove/delete with undo, the team CHECK constraints and one-pending-request index, and the member-status-equals-team-status invariant after every mutation |
| `judging.db.test.ts` | Hackathon judging ([HACKATHON.md](HACKATHON.md)): submissions refused outside the window, while disabled, for unpublished events, and for non-confirmed entrants; entrant, organiser, and judge ids re-scoped to another event or organisation; a solo submission link never edits another entrant, is mailed only to the registration, and is retired when regenerated; a `JUDGE`-only collaborator reaches no guests, teams, mobile organiser API, or other event; conflict of interest (team member, solo owner, org admin) hides and refuses the entry; scores refused unless judging is open and the project is submitted; concurrent submission, score, and review writes stay unique (one receipt email); the result-score formula, tie ranks, and CSV rows; awards only for submitted projects; the results page and gallery hidden until published and for unreleased, unpublished, and invite-only events |
| `mobile-sessions.db.test.ts`, `request-actor-auth.db.test.ts`, `staff-mfa-actor.db.test.ts` | Mobile sessions ([MOBILE_API.md](MOBILE_API.md)): only token digests stored, refresh rotation with the 30-second retry grace, reuse and other-install refresh revoking the session, session-version revocation and retention; `auth()` presenting the app session (its authenticator check and sign-in age) only inside a request actor; the staff authenticator rule for app sessions, cookie sessions unchanged, and a staff check with neither failing closed |
| `mobile-api.db.test.ts`, `mobile-api-dayof.db.test.ts`, `mobile-teams-judging.db.test.ts` | The Yuyu-derived mobile suites: sign-in and refresh, generic credential errors, sign out everywhere needing a recent sign-in, tenant `NOT_FOUND`, CHECK_IN collaborators checking in (`mobile-scan`) but not approving or emailing, ticket tokens only for their owner, the organiser programme, closing and reopening sign-ups, restore scoped to its event, and teams and judging with their refusal codes |
| `mobile-api-security.db.test.ts`, `mobile-api-paid.db.test.ts`, `mobile-api-crew.db.test.ts` | Space Works on mobile: `STAFF_MFA_REQUIRED`/`STAFF_MFA_ENROLMENT_REQUIRED` on organiser routes until `POST /auth/mfa`, the 12-hour expiry, the new-install emailed code and alert; a paid RSVP held as `PENDING_PAYMENT` with a checkout and never confirmed unpaid, orders only for their buyer and event, the desk's amount due, `PAID_ORDER` on cancelling a paid ticket, and a re-accepted paid request offered a payment link; crew tickets outside capacity, crew managed only with `MANAGE_REGISTRATIONS` in the event's own organisation |
| `mobile-idempotency.db.test.ts`, `mobile-finance-claims.db.test.ts`, `mobile-idempotency-coverage.test.ts` (unit) | Idempotency-Key handling (replay only for the same path and body, multipart retries with a new boundary, transient refusals never kept, stale first requests, only HMACs and no ticket tokens stored); every signed-in mobile write except the documented exemptions takes a key and the OpenAPI marks it required; a replayed partial refund refunds once and a replayed order registers once (`mobile-api-paid`); staff claims filed and withdrawn by JUDGE, MENTOR and REVIEW_APPLICATIONS collaborators on their own event only |
| `money-audit-orders.db.test.ts`, `money-audit-admission.db.test.ts` | A desk-owed ticket and a PER_TEAM leader's team ticket cancelled only as an order (`PAID_ORDER`); transfers refused with `OPEN_CLAIMS` while claims are waiting, approved or paid; a refused refund approval reopened only while the guest still says No (withdrawn after a Yes); the buyer's own open request recorded on an attendance No; a paid solo applicant on a TEAM event offered a place while a unit is free; an applicant's place never waived, though desk money is recorded. `hackathon-email-toggles-fees` adds the refused reinstatement of a project whose fee was refunded |
| `mobile-judging-rounds.db.test.ts`, `mobile-mentor-desk.db.test.ts` | Judging rounds on mobile (the judge's rounds without later drafts, round-scoped reads, current-round writes, the organiser summary, finalists only once published); the Mentor Desk on mobile (idempotent help with replay and refusal of a reused key, the team-only view, one winner of a claim race, mentor isolation from organiser tools, tenancy, a fresh authenticator check for mentor-only sessions) |
| `mobile-api-contract.test.ts`, `mobile-secret-fields.test.ts` (unit) | The OpenAPI contract, fixtures, Zod schemas and implemented routes stay in step; no mobile DTO can carry a secret, an order access token, team or submission links, or an unconfirmed ticket token |
| `dashboard-loading-boundaries.test.ts` (unit) | Every `loading.tsx` in `app/` is pinned to the layout that awaits the wrapped pages' access check (`lib/views/dashboardGuards.ts`) and to the exact pages it wraps; there is no root, dashboard-wide, organisation-wide or event-wide `loading.tsx` |
| `judging-results-equivalence.db.test.ts` | The aggregated judging reads ([Large-event performance](PERFORMANCE.md)) give exactly the previous implementation's ranking under both score methods, counted reviews, Progress outliers and stale lists, and judging CSV, on data with revoked judges, a conflict of interest, drafts, partial and out-of-range scores and ties |
| `offline-roster.db.test.ts` | The set-based offline check-in roster: eligible registrations newest first with their user, team and answers; another organisation's event refused |
| `raw-sql-timezone.db.test.ts` | Raw SQL on a database whose `TimeZone` is Asia/Kolkata: the `lib/sqlTimestamp.ts` helpers write and compare UTC wall-clock time, a webhook delivery is not claimed before its retry time, and a registration whose event ended an hour ago is filed under Past |
| `judging-core.db.test.ts` | End-to-end smoke run of the judging cores: CHECK constraints, cascades, and results publication with its emails (opted in) |
| `mentor-desk-help.db.test.ts` | Mentor Desk help queue ([MENTOR_DESK.md](MENTOR_DESK.md)): per-team open limit and privacy, two mentors claiming at once (one wins), one live claim per mentor (and the partial unique index), lease fencing by claim id and generation, a lapsed lease refused while reads leave it untouched, off-shift refusal, the assigned mentor's priority window, skill tags and conflicts, the full lifecycle with audit metadata free of help text, the deadline inside commands, the expiry beat run twice concurrently, and append-only activity rows |
| `mentor-desk-assignments.db.test.ts` | Preview writes nothing; seeded RANDOM reproducible and varying by seed; conflicts, team membership and capacity never broken; a stale fingerprint refused; runs recorded with seed and uncovered teams (append-only); activation rechecks capacity; hand edits recorded; per-round pools isolate rounds; fresh eyes across stages (hard and soft); a mentored team is a judging conflict only while the desk is on |
| `mentor-desk-office-rounds.db.test.ts` | Concurrent bookings fill a slot exactly to capacity; no overlapping team bookings; reschedules logged with a reason (append-only); no team cancel after start; one live round; pool, ten-minute visit leases and stale-lease refusal; one check-in per team and round; away check-ins cannot nominate; help triggers; fresh eyes in the next round; `tookPartInRound`; nominations private and append-only |
| `mentor-desk-followups.db.test.ts` | Removing a `MENTOR` grant cancels future slots and bookings (logged, emailed), ends visit leases and pool places; only activated assignments count as mentored; mentors clear only conflicts they declared, with versions; concurrent booking cancels apply once; reschedules recheck booked teams; lapsed-lease cancel and organiser release; the reopen open limit; the optional mentor crew ticket created and removed only by the hook; a mentor-only grant's dashboard and staff-claim scope |
| `mentor-desk-permissions.db.test.ts` | `MENTOR` satisfies no other check and opens only the console (`isMentorOnly`); staff MFA required; organisations and events apart; only a signed-in confirmed registrant (or the team link) raises help, and nobody with the desk off; invite acceptance creates the profile and removing the grant ends assignments |
| `hackathon-email-toggles.db.test.ts` | Hackathon emails ([HACKATHON.md](HACKATHON.md) → Hackathon emails): both switches `NOT NULL DEFAULT false`; publishing with the results switch off queues nothing; Send results email now once under concurrent sends and only to entrants not yet told; receipts only when on; registration, team and submission-link emails always queued; co-organisers with every grant and other organisations refused; clone copies the switches |
| `hackathon-email-toggles-fees.db.test.ts` | The submission receipt on the entry-fee path follows the switch (provider, offline and waived settlement, read at confirmation time); the *paid* and *refunded* payment emails are never gated |
| `judging-rounds.db.test.ts`, `judging-rounds-advance.db.test.ts`, `judging-rounds-assign.db.test.ts`, `judging-rounds-migration.db.test.ts` | Judging rounds ([HACKATHON.md](HACKATHON.md#rounds)): one OPEN round per event, order and status rules, panels, tenancy and owner/admin-only actions; finalist advancement (preview, fingerprint, finalised source, frozen entries, disqualified never advance), final-round results and awards, finalist publication and email; seeded Random runs, fresh eyes, audited manual changes; the migration backfill and expand-phase triggers. The existing judging suites run unchanged on single-round events |
| `admission-free.db.test.ts`, `admission-paid.db.test.ts`, `admission-holds.db.test.ts`, `admission-review.db.test.ts`, `admission-guards.db.test.ts`, `admission-batches.db.test.ts`, `admission-outputs.db.test.ts`, `admission-retention.db.test.ts` | Applications ([ADMISSION.md](ADMISSION.md)): a free non-hackathon event end to end (stage 1 → shortlist → offer → accept with ticket, decline, expiry, waitlist promotion) and a free team; paid solo and PER_TEAM places never confirmed unpaid (database guard), a free ticket type on a paid event, the PER_MEMBER refusal; ended holds back to OFFERED or EXPIRED with the order cancelled, applying teams kept; offer capacity counting places being paid; seeded reviewer assignment, conflicts, coverage and overrides, append-only reviews and answer revisions, recusal, reviewer isolation behind staff MFA; crew never applications; the old approve/decline/promote/re-accept/waitlist paths refused; tenancy; batch atomicity and cancel; FIFO promotion passing over a full ticket type and an incomplete team; the webhook and machine API carrying ids and counts only; the stage email switch; retention (a deleted registration withdraws and detaches its application with reviews, decisions and answer revisions kept, history deleted only with the event, one application per person, nothing created confirmed, decided teams take nobody new, no offers after the start, a reviewed stage keeps its rubric, reviewed assignments stay, trigger-made transitions recorded and sent). `assignment-planner-parity.test.ts` and `admission-rules.test.ts` (unit) pin the shared planner to the pre-extraction judging plans and cover the pure rules |
| `saved-views.db.test.ts` | Saved views: each list's own permission (People/Teams `MANAGE_REGISTRATIONS`, Judging owner/admin; a `JUDGE`, a plain member and another organisation refused), params sanitised on write and read, private versus shared listing, only creators rename or share, owners/admins delete shared views (a non-admin can't), event/surface scoping, audits without names, name and object-params CHECKs, cascades from user and event; and the preset filters: People `notCheckedIn`, Teams `looking`, Submissions *Not submitted* entrants (teams and solos, search, no emails, organisation-scoped) and Results `scored` with unchanged ranks |
| `filtered-exports.db.test.ts` | Filtered CSV exports on more rows than one server batch (531 registrations, 211 teams, 205 projects): People, Teams, Submissions and Results files hold exactly the rows their filters match with the unfiltered People file unchanged, formula-like cells neutralised, the search kept inside the event, audits with filter names only, each export's own access (a `MANAGE_REGISTRATIONS` co-organiser for People and Teams, owners/admins only for judging) and an empty 404 for members, other organisations and malformed or other-view parameters; Feedback responses paged 25 at a time once each with stable numbers, owner/admin only |
Attendance confirmation ([ATTENDANCE.md](ATTENDANCE.md)) unit suites are `attendance-check` (the eligibility rule, badge states and "Said No · paid", open strictly until the start, the 12-hour interval, closed reasons with cancellation first, the `?answer=` preselect, the 256-bit token and its digest, the strict validators and the 500-character note, and the email's absolute links, escaping, reminder subject and release copy for free and paid places), `attendance-outbox` (the bulk capability kind, payload checks, delivery that deletes the row, drops rotated, answered, ineligible and cancelled-event questions, expires at the start, and passes the release kind computed at delivery), `attendance-guest-list` (the People filter, badge, counts and CSV cells), `attend-page` (`/attend/:token`: `noindex`, `no-referrer`, real 404s, own details only, the release warning for free and paid places, the closed states) and `attendance-migration`, plus the attendance rows of `proxy-headers`, `next-config-headers`, `robots`, `chrome-switch`, `check-in-station-route` (the reply, never the note), `event-dashboard-overview-metrics` (the Overview line only for people who may email guests), `attendee-export-route`, `guest-paging`, `account-data-export` and `event-client-dto`.

| Attendance suite | What it proves |
| --- | --- |
| `attendance-send.db.test.ts` | Nothing is sent by the scheduled jobs and a preview is read-only; only CONFIRMED registrations of the event are asked (each team member individually), series dates never; concurrent sends ask everyone once; a repeat send asks only newly confirmed guests; refused after the start, for a cancelled event, signed out and malformed; owner (through the Server Action) and admin allowed, a member, another organisation's owner, every single collaborator grant, `JUDGE` and all grants refused; never across tenants; the switch audited only on change |
| `attendance-reply.db.test.ts` | Reminders only for no-reply eligible guests, once per 12 hours, rotating the link so the old one 404s; the reply view holds only the guest's own details (no ticket token, RSVP id or digest); answers change until the start; token isolation across events and organisations, digests and unknown tokens refused; closed states; cascades and the four CHECK constraints |
| `attendance-release.db.test.ts` | A free No releases through `cancelRegistrationByToken` without revalidation and promotes the waitlist; other self-cancels still revalidate; a team leader's No hands leadership on; a checked-in guest keeps the place with `releaseOutcome = "failed"`; a Yes never releases; delivery sends once, drops stale questions, expires at the start, and says a No releases only when the switch is on at delivery |
| `attendance-paid.db.test.ts` | Paid tickets: a single ticket answered by its buyer is cancelled under a 50% policy (half refunded); a closed policy keeps the place and opens one refund request (reused on a repeat No); several tickets, a PER_TEAM team ticket and a ticket somebody else paid for are never cancelled and organisers are told once per No; release off records only; a checked-in buyer keeps the place |
| `attendance-link.db.test.ts` | Share attendance link: asks a guest without an email (a later send skips them), replaces an emailed link (not delivered), audits without the token, returns an absolute link, refuses members, other organisations, every grant, other events' and tenants' guests, unconfirmed guests and closed events |
| `attendance-paid-followups.db.test.ts` | Desk orders still owed: a 3-ticket order's guest saying No releases nothing; a single desk ticket's buyer saying No cancels the order and its owed payment with no refund. One kept-place notice and one refund request per check through Yes/No toggles; a Yes withdraws the open request it opened (audited, organisers told) and leaves a declined one alone with the answer shown in Finance; two windows answering at once run one release; the form and email name the policy refund |
| `mobile-api-attendance.db.test.ts` | The mobile API's attendance: nothing before the guest is asked; an attendee reads and answers their own question with the app session (the link digest never returned), anyone else's registration is NOT_FOUND and no bearer is 401; a free No releases the place; `EventCounts.attendance` only for `sendEmails`; the share-link endpoint for owners/admins only, refused for a co-organiser with every grant (403), another organisation (404) and a waitlisted guest (409), stored as a digest and audited |
| `attendance-crew.db.test.ts` | Crew are never previewed, asked, reminded, counted as "Not asked" or given a shared link; a guest added to the crew loses the question and its link |
| `attendance-check-card.db.test.ts` | The Emails card: not sent yet, the last send and its sender, replies and newly confirmed guests, remindable after 12 hours, closed after the start and when cancelled; the Overview counts; clone copies the switch but no checks |
| `attendance-guest-list.db.test.ts` | Guests · People filter and counts inside the event, the paging action behind the registration-manager check, CSV columns and filter, the desk lookup, preview and offline roster showing the reply but never the note, and the personal data export |

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

Production mode prepares and starts `.next/standalone/server.js`, including public and static assets. The suite checks liveness, Auth.js polling limits, mobile navigation, login/crawler controls, confirmed tickets, waitlisted ticket rejection, feedback, JPEG certificates, and short-link redirects and not-found behaviour. `broadcast-drafts.spec.ts` checks that a custom email autosaves, guards leaving while unsaved, survives a reload, asks before a template replaces it, and is cleared by a real send after the undo window, and that **Discard draft…** removes it. `check-in-lists.spec.ts`: an admin creates a "Swag" list from Manage lists, checks a confirmed guest in by search (count goes to 1), gets "Already checked in to Swag at …" for the typed ticket, undoes it, filters the list's guest view, and then checks the same guest in at Entry independently; a `CHECK_IN`-only co-organiser scans a ticket into the list but sees no Manage lists. `webhooks.spec.ts` adds a webhook endpoint as an admin (local receiver; needs `WEBHOOKS_ALLOW_PRIVATE_TARGETS=1`), sees the secret once, sends a test and sees the 200 in the delivery log with a valid signature, and checks that a member is redirected away from the settings and Webhooks pages. `crew.spec.ts`: the crew link page is private and unindexed (unknown tokens 404), a crew member signs up and starts hidden, the crew ticket never takes the only place on the public card, the public Crew section appears only when switched on and shown and never carries email, food or the token, and the organiser sees the member, food summary and link in Guests → Crew. `crew-smoke.spec.ts` (steps in `tests/e2e/helpers/crew-smoke-steps-*.ts`): an organiser adds, validates, edits, reorders, shows and hides crew, converts a registered attendee (Overview shows `+ N crew`), sees crew marked in People without edit or remove, creates, replaces and turns off the link, turns the section on, opens a crew ticket page (no cancel), checks crew in at the desk (Crew badge and food preference), and removes a member. `teams.spec.ts`: a serial team registration story ([Teams](TEAMS.md)): the organiser turns on team registration in Publishing, a leader creates a team through the public form (the management token is read from the queued `team-created` email), the team page shows the join link, a teammate joins through it, the join link 404s for hidden, draft, invite-only and unreleased events, a solo registrant pastes the join link on their ticket page (a management link is refused) and keeps their ticket in the team, and an organiser approves a team on an approval-required event so both members' tickets show it. `/team/:token` and the join page must send `Referrer-Policy: no-referrer`, a `noindex` robots tag, and a non-shareable `Cache-Control` (`no-store` under `test:e2e:production`; `next dev` always sends its own `no-cache`). `pagination.spec.ts`: large-event paging on seeded data (60 teams, 61 registrations, 60 ranked projects, 55 invites): Guests · People shows 50 with whole-event chip counts, Load more reaches the oldest guest, and the server search finds that guest by name and email from a fresh page; Guests · Teams loads 50 then the rest; Judging → Results shows numbered pages of 50 with ranks computed over the whole ranking (a tie keeps rank 49 across the page break); Guests · Invites shows numbered pages of 50 and searches by email. `saved-views.spec.ts`: Saved views on seeded data: People opens filtered from `?status=waitlist` (unknown keys ignored), the Views menu applies *Not checked in* and writes it to the address, Copy link holds tab, sub-tab and filters, and a sub-tab switch clears them; a Teams view is saved and shared, re-applied from a fresh visit, renamed and deleted from Manage views; Submissions *Not submitted* lists the team without a submitted project, Results opens on *Unscored*, and Progress shows only *Below target*. `filtered-exports.spec.ts`: The dashboard renders a streamed panel once (a MutationObserver from the first byte never sees two `#guest-search`, and no hidden `div#S:*` copy remains); People, Teams, Judging → Submissions and Results **Export CSV** links follow the chip and search showing and download exactly those rows; Feedback responses page 25 at a time. `dashboard-not-found.spec.ts`: dashboard refusals are real statuses, never a streamed 200: signed-out requests 307 to sign-in; an owner gets 200 on their own pages (members, member IDs, ticket designs, every settings page, check-in, badges, schedule) and 404 for another organisation's or an unknown event, series, webhook endpoint, ID programme or ticket design (without the protected title in the body) and 307 for another organisation; a member gets 307 from owner/admin pages and 404 from check-in, badges and schedule; a JUDGE-only collaborator gets 200 on their event and 404 on its check-in desk, badges, schedule and every other event. `help.spec.ts`: the guide home opens an article, search jumps to the door station article, and signed-out readers never see or open the owner/admin and super-admin sections (404) or get them from the search index. `help-gating.spec.ts`: a seeded owner reads the developer section (`no-store`) but not the instance one, and a plain member gets 404 and a public-only search index. `create-event-timezone.spec.ts`: from a browser on Pacific/Auckland, the New event dialog suggests a whole hour at least 30 minutes away on the event's clock, its earliest start follows the chosen timezone, and the stored start is the picked wall-clock time in America/New_York; `/discover` does not scroll sideways at 390px with a 200-character unbroken title, tag and place, in light and dark. `series-occurrence.spec.ts`: registering as a guest on a public series date shows the confirmation and the card's count goes from "0 going" to "1 going" without a reload.

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
