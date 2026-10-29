# Production operations

[Documentation index](README.md)

## Required managed services

- PostgreSQL with TLS, encryption at rest, point-in-time recovery, daily backups, and a tested restore process.
- Redis reachable through `REDIS_URL`; production writes fail closed when it is unavailable. Redis pub/sub also carries live ticket check-in notifications between replicas.
- A reverse proxy that does not buffer `text/event-stream` responses for `/api/ticket/:token/events` (nginx: `proxy_buffering off`; the route also sends `X-Accel-Buffering: no`) and allows idle reads of at least 30 seconds. A buffering proxy delays the live ticket tear until the client's 15-second status check.
- Private S3-compatible object storage for generated safe image derivatives.
- Transactional email with a verified sending domain, SPF, DKIM, DMARC, bounce handling, and delivery monitoring.
- Outbound HTTPS (ports 443 and 8443) from every app process to the receivers organisations configure for webhooks ([Organisation webhooks](WEBHOOKS.md)). If egress is restricted, deliveries fail and retry, then the endpoint is switched off after 20 consecutive failures; the user actions that raised them are unaffected.
- Edge TLS termination and WAF/rate limiting. Configure only proxy headers that the edge overwrites.
- If Cloudflare proxies the application, disable Email Address Obfuscation for the application hostname. Space Works Events sends `Cache-Control: no-transform` on HTML responses so Cloudflare does not inject its unsigned email-decoder script into pages protected by the nonce-based CSP.

## Deploy procedure

Certificate designer releases require the `20260916000000_certificate_templates` migration before application rollout. Certificate artwork and image layers (logos, signatures, seals under `certificate-assets/`) are re-encoded as WebP in private storage and delivered through the application image route; upload blank artwork without personal data. Keep the Docker image's DejaVu fonts installed (Serif, Sans, and Sans Mono). Custom certificates use the saved layout snapshot on each response.

The default production deployment is the
[free-tier cloud stack](DEPLOYMENT_CLOUD.md): Render builds `render.yaml`'s
Docker service on every commit that passes CI, the container applies
migrations on start (`MIGRATE_ON_START=1`, through `DIRECT_URL`), and the
Cloudflare Worker in `deploy/cloudflare-cron` calls the outbox endpoint every
minute (step 4 below), which keeps the free instance awake. Steps 1–2 are then
automatic; still review migrations and take a backup before merging one.

For a complete single-host stack, follow the
[Docker VPS guide](DEPLOYMENT_VPS.md) and `compose.production.yml`. For an app
container with separately provided services, follow the
[production Docker deployment guide](DEPLOYMENT_DOCKER.md). The repository's
root Compose file is development-only, and `compose.staging.yml` is not a
production topology. Kubernetes operators should use the
[Helm chart](../charts/spaceworks-events/README.md).

1. Build and test the immutable image in CI. The [releases and container images guide](CONTAINER_IMAGES.md) covers automated publication of the application, migration and operator images.
2. Run `npm run db:status`, then `npm run db:deploy` once as a release job using the migration database role. Run `npm run storage:migrate` when legacy database assets remain.
3. Deploy application instances using a least-privileged runtime database role and production secrets from a secrets manager.
4. Verify the email worker and the beat have recorded fresh heartbeats after deployment (Super admin → Operations). Where the platform cannot keep them running, such as a sleeping free instance, configure a cron service to call `POST /api/internal/outbox` every minute with `Authorization: Bearer $CRON_SECRET`; also configure an authenticated readiness probe to call `GET /api/health/db` with `Authorization: Bearer $HEALTHCHECK_SECRET`.
5. Verify readiness, error rate, email queue depth, database connections, and Redis health before shifting traffic.

### Reserved organisation addresses

A release can reserve new top-level addresses. Release 0.11.0 reserves five new
ones: `/attend` (attendance confirmation), `/crew` (crew sign-up), `/help`
(the in-app guide), `/submit` (project submission links) and `/team` (team
management links). It also reserves `/order` (order links) and `/verify-mfa`
(the staff authenticator check), which 0.10.0 already served without
reserving them.
An organisation that already uses one of those slugs would have its public page
hidden behind the built-in route. The reserved list is
`scripts/reserved-slugs.mjs`; `lib/slug.ts` refuses those slugs for new and
renamed organisations. Slugs match case-insensitively (`Help` counts).

Two checks name each affected organisation:

- `node scripts/check-reserved-slugs.mjs` runs **before migrating** (read-only,
  one `SELECT`): the VPS updater (`scripts/update-vps.sh`) stops there and
  keeps the previous release serving, and the Helm migration Job fails the
  release with nothing migrated.
- `npm run db:verify` (CI, the VPS update and `docker/vps/check.mjs`) repeats
  it after migrating.

**Render** has no pre-deploy command on the free plan (the container migrates
on start), so check before merging or deploying a release that reserves an
address: run `node scripts/check-reserved-slugs.mjs` with the service's
`DATABASE_URL`, or this in the Supabase SQL editor (it must return no rows):

```sql
SELECT slug FROM "Organisation" WHERE lower(slug) IN ('attend', 'crew', 'help', 'submit', 'team', 'order', 'verify-mfa');
```

To fix it before deploying: pick a free slug, rename the organisation in a
transaction, and tell its owner that the public address changed (old shared
links to `/<old-slug>` will open the built-in page instead):

```sql
UPDATE "Organisation" SET slug = 'help-centre-org' WHERE slug = 'help';
```

Check the new slug is unused first (`SELECT 1 FROM "Organisation" WHERE lower(slug) = lower('…')`),
then re-run the check.

### Recent schema migrations

Apply these with `npm run db:deploy` before rolling out the matching application version. Release 0.10.0 ends at `20261102000000_event_broadcast_drafts`; release 0.11.0 adds everything from `20261103000000_check_in_lists` to `20261119030000_admission_audit_fixes`; later migrations belong to the next release. The **Rolling deploy** column says whether instances of the previous release keep working while the migration has run and they have not yet been replaced, and what to do before or after upgrading.

How to read the lock notes. Prisma runs each migration in one transaction without a lock timeout, and every lock is held until that transaction commits, so a table altered early in a migration stays locked through the migration's later steps:

- `ALTER TABLE` takes an ACCESS EXCLUSIVE lock: reads and writes of the table wait. Adding a column with a constant default or no default rewrites nothing, so the lock is brief unless a later step scans the table.
- A CHECK added without `NOT VALID` (or validated in the same migration) and a foreign key on an existing table scan it under that lock.
- `CREATE INDEX` takes a SHARE lock (reads continue, writes wait) for the length of the build. Indexes on columns that already exist can be built beforehand with `CREATE INDEX CONCURRENTLY` (see the lock checklist below).
- A new table's foreign key and `CREATE TRIGGER` take a SHARE ROW EXCLUSIVE lock on the existing table: writes wait briefly, nothing is scanned.
- `ALTER TYPE … ADD VALUE` locks no table. An older release's Prisma client cannot read a row that uses a value it does not know, so start using a new value (the notes say which) only after every instance runs the new release, and do not roll the application back once rows use it.

| Migration | Change and locks | Rolling deploy |
| --- | --- | --- |
| `20261013000000_event_broadcasts` | `EventBroadcast` history for organiser emails. New table | Safe |
| `20261015000000_registration_question_settings` | `EventRegistrationField.helpText`, `placeholder`, and nullable `settings` JSON | Safe |
| `20261016000000_event_listed_publicly` | `Event.listedPublicly` (default `false`) for listed approval-required events | Safe |
| `20261017000000_broadcast_design` | `EventBroadcast.design` (default `classic`) | Safe |
| `20261018000000_rsvp_user_index` | `RSVP_userId_createdAt_idx` on `RSVP(userId, createdAt)` for account pages and the personal data export. A plain `CREATE INDEX`: RSVP writes wait while it builds | Safe. On a large installation pre-build it `CONCURRENTLY`, or run it in a quiet window |
| `20261019000000_event_short_code` | Nullable `Event.shortCode` with a unique index | Safe |
| `20261019010000_event_badge_design` | New `EventBadgeDesign` table, one saved ID card design per event (cascades with `Event`, `SET NULL` on the editing `User`) | Safe |
| `20261020000000_member_ids` | Member IDs: new `IdProgramme`, `IdProgrammeField` and `IdMember` tables and five enums, cascading from `Organisation`. New tables only | Safe |
| `20261021000000_member_id_integrity` | `IdMember.lastEmailedAt`; the `IdMember(organisationId)` index becomes `(organisationId, lastEmailedAt)`; a composite foreign key keeps each member in its programme's organisation (validated by a scan of `IdMember`) | Safe |
| `20261022000000_payments_core` | `InstanceSetting.paidEventsEnabled` (default `false`), `OrganisationPaymentSettings` and `ProcessedWebhookEvent` tables, `PaymentProvider` enum | Safe. Paid events stay off until the super admin turns them on |
| `20261022000100_rsvp_pending_payment` | Adds `PENDING_PAYMENT` to `RsvpStatus`, alone in its migration | Turn paid events on only after the rollout: an older release cannot read a registration in that status |
| `20261022000200_payment_ledger` | Paid-event ledger: `TicketType`, `Order`, `OrderLine`, `Payment`, `PaymentCheckoutAttempt` and `PaymentRefund` with five enums and ledger guard triggers; `Event.currency`; `RSVP.holdExpiresAt`, `orderId`, `ticketTypeId`, three RSVP indexes, two RSVP foreign keys and the `RSVP_pending_payment_hold` CHECK. `RSVP` is ACCESS EXCLUSIVE from its `ALTER TABLE` to commit, through the CHECK scan, the foreign key scans and the three index builds | Safe (new columns are nullable). On a large installation run it in a quiet window with a lock timeout |
| `20261023000000_analytics_insights` | `RSVP.waitlistedAt` and `promotedAt`, a backfill of `waitlistedAt` from `createdAt` for waitlisted rows (under the RSVP lock), the `rsvp_waitlist_dates` trigger on `RSVP`, and the `ShortLinkClickDay` table | Safe: the trigger fills the dates for writes from either release |
| `20261023000000_event_currency_lock` | Trigger: an event's currency never changes once set | Safe |
| `20261024000000_order_requested` | Adds `REQUESTED` to `OrderStatus` | Safe |
| `20261024000100_payment_operations` | Structured refund policy on `Event` (CHECK scans `Event`), promo code and refund policy on `Order`, offline payment fields on `Payment`, new `PromoCode` and append-only `PaymentAmendment` tables | Safe |
| `20261025000000_payment_receipts` | Receipt details on `OrganisationPaymentSettings` and the payment method on `Payment`, with shape CHECKs | Safe |
| `20261026000000_paid_series` | Paid series: `EventInstance.capacity` and `cancelledAt`, series currency and refund policy, order targets for a series or date, `TicketType.kind` (`SINGLE`/`PASS`), target CHECKs and triggers. Replaces RSVP's order and ticket-type foreign keys (an order's tickets now go with it) and adds the `rsvp_ticket_type_target` trigger; `RSVP` stays ACCESS EXCLUSIVE while the new foreign keys validate (a scan of `RSVP`) | Safe. Quiet window on a large installation |
| `20261027000000_ticketing_extras` | Ticket access codes, members-only visibility, pay what you want, group tickets and booking fees on `TicketType`; new `AddOn` table and `OrderLine.addOnId`. Defaults keep today's behaviour | Safe |
| `20261028000000_after_purchase` | Ticket transfers (`allowTransfers`, off, and `transferCutoffHours` on `Event` and `EventSeries`, with CHECKs), `Order.paymentReminderSentAt`, `TicketType.payAtDesk`, new `PaymentDispute` table | Safe |
| `20261029000000_event_reminders` | Nullable `RSVP.reminderSentAt` | Safe |
| `20261030000000_organisation_email` | New `OrganisationEmailSettings` table (sender name, reply-to or the organisation's own SMTP server, secrets encrypted) | Safe |
| `20261031000000_user_devices` | New `UserDevice` table (a SHA-256 of each browser's device id) for new-device codes and sign-in alerts | Safe |
| `20261031000100_realign_event_publication` | Data only, idempotent: `EventPage.isPublished` follows `Event.status = PUBLISHED` again, and published events without a page row get a released one. Published events left at 404 by the old Overview **Publish event** button become public | Safe |
| `20261031000200_ops_alert_webhook` | `InstanceSetting` alert webhook columns (encrypted URL, enabled flag off by default, include-warnings flag) | Safe |
| `20261101000000_chat_channels` | New `ChatChannel` table and `ChatChannelKind` enum for per-organisation chat notifications (secrets encrypted) | Safe |
| `20261102000000_event_broadcast_drafts` | New `EventBroadcastDraft` table for saved Emails-tab drafts: one row per event and organiser (unique on `eventId`, `userId`), cascading on `Event` and `User`, with CHECKs bounding the subject to 150 characters and the audience to four statuses | Safe |
| `20261103000000_check_in_lists` | New `CheckInList`, `CheckInListRecord` and `CheckInListEvent` tables for custom check-in lists: a partial unique index on (`eventId`, `lower(name)`) for non-archived lists, a unique (`listId`, `rsvpId`) record per guest, CHECKs on the name shape, sort order, sources and history actions, cascades from `Event` and `RSVP` (history keeps a null `rsvpId`), and `SET NULL` on the acting `User`. Entry check-in tables and rows are unchanged; no backfill. `db:verify` checks the three tables and their key constraints | Safe |
| `20261103010000_org_webhooks` | New `WebhookEndpoint` and `WebhookDelivery` tables and the `WebhookDeliveryStatus` enum, cascading on `Organisation` (endpoints) and `WebhookEndpoint` (deliveries), with CHECKs on URL/description length, event-type count, failure counter, attempts, error length and the lease shape | Safe |
| `20261104000000_team_registration` | Team registration: `Event.registrationMode` (default `INDIVIDUAL`), solo policy and team sizes with CHECKs (a scan of `Event`); new `Team`, `TeamSeekerProfile` and `TeamJoinRequest` tables; nullable `RSVP.teamId` with an index and a foreign key. `RSVP` stays ACCESS EXCLUSIVE while `RSVP_teamId_idx` builds and the foreign key validates (each a full pass over `RSVP`); the column is new, so the index cannot be pre-built | Safe: existing events stay individual. Quiet window on a large installation |
| `20261104010000_hackathon_judging` | Submissions and judging: `Submission`, `SubmissionLink`, `JudgingCriterion`, `JudgeAssignment`, `JudgeScore`, `JudgeReview`, `EventAward`, `EventAwardWinner`; judging columns on `Event` with defaults; adds `JUDGE` to `EventPermission` | Safe. Grant `JUDGE` only after the rollout: an older release cannot read a collaborator that has it |
| `20261104020000_judging_results_announced` | Nullable `Event.resultsAnnouncedAt` | Safe |
| `20261104030000_judging_ops` | `Event.reviewsPerProject` and `Event.scoreNormalization` (default `RAW`) with a range CHECK (a scan of `Event`) | Safe |
| `20261104040000_saved_views` | New `SavedView` table and `SavedViewSurface` enum, cascading on `Event`, `User` and `Organisation` | Safe |
| `20261105000000_paid_options` | Who pays on a team event (`Event.teamTicketMode`, default `PER_MEMBER`), project entry fees, the team or entry fee an `Order` is for (with CHECKs), `CheckInList.addOnId`, `EventAward.prizeMinor`, the append-only `PrizePayout` ledger with guard triggers; `ChatChannel_shape` is replaced to allow `payout` (a scan of `ChatChannel`). `Order` stays ACCESS EXCLUSIVE (reads and writes of orders wait, so checkout and payment webhooks queue) through its CHECK scans, index builds and foreign key validations | Safe. Quiet window on large paid installations |
| `20261106000000_event_finance` | Event finance: `ExpenseClaim`, `ExpenseReceipt`, the append-only `ClaimPayout` ledger and `RefundRequest` (one open request per order), four enums; budget and participant-claim columns on `Event` with a CHECK (participant claims off); `ChatChannel_shape` allows `claim` | Safe |
| `20261107000000_ticket_designs` | New `TicketDesign` table; nullable design ids on `Organisation`, `Event` (both with unique indexes) and `TicketType`, with triggers keeping each design in its owner's organisation or event | Safe |
| `20261107010000_ledger_guards` | `Order.teamJoin` (default `false`); triggers refuse deleting prize and claim payout rows except through their organisation's deletion | Safe |
| `20261107020000_drop_orphan_event_session_type` | Drops the unused `EventSessionType` enum (no column has used it since `20260915010000_simplify_event_session_fields`). No table changes or locks; `prisma migrate diff` against `schema.prisma` is then empty | Safe |
| `20261108000000_large_event_indexes` | Six composite indexes for keyset-paged lists ([PERFORMANCE.md](PERFORMANCE.md)): `RSVP_eventId_createdAt_id_idx`, `RSVP_eventId_checkedInAt_id_idx`, `Team_eventId_createdAt_id_idx`, `Submission_eventId_createdAt_id_idx`, `Submission_eventId_status_submittedAt_id_idx`, `EventInvite_eventId_createdAt_id_idx`. Plain `CREATE INDEX IF NOT EXISTS`: each build blocks writes to its table (registrations, check-ins, submissions, invites) until it finishes | Safe. On a large installation pre-build the `RSVP` and `EventInvite` indexes `CONCURRENTLY` (checklist below); upgrading from 0.10.0, `Team` and `Submission` arrive empty in the same release |
| `20261109000000_hackathon_email_toggles` | `Event.emailEntrantsOnResults` and `Event.emailSubmissionReceipts`, both `NOT NULL DEFAULT false` (no rewrite; a brief ACCESS EXCLUSIVE lock on `Event`). `db:verify` checks both columns | Safe. **Behaviour change for existing events:** both switches start off, so publishing results and submitting a project (including one submitted once its entry fee is paid) send no email until an organiser turns the switch on in Judging → Setup ([HACKATHON.md](HACKATHON.md) → Hackathon emails). Payment emails are unaffected. This only affects an instance that already ran a build with judging (`20261104010000_hackathon_judging`); upgrading from 0.10.0, which has no judging, changes nothing. Tell organisers who rely on those emails before upgrading |
| `20261110000000_event_crew` | Event crew ([CREW.md](CREW.md)): adds `CREW` to `EventPageSectionType` and `ExpenseClaimKind`; `Event.crewClaimsEnabled` and `RSVP.isCrew` (both default `false`, no rewrite); `EventCrewMember` and `EventCrewJoinLink` tables; the `RSVP_crew_shape` CHECK is added `NOT VALID` and validated in the same transaction, so `RSVP` stays ACCESS EXCLUSIVE during the validation scan | Add crew and the Crew page section only after the rollout: an older release counts crew tickets as attendees and cannot read a page with a Crew section |
| `20261111000000_attendance_confirmation` | Attendance confirmation ([ATTENDANCE.md](ATTENDANCE.md)): `AttendanceResponse` enum, `AttendanceCheck` table (one per registration, link token stored as a SHA-256 digest only), `Event.attendanceCheckReleaseOnDecline` (default `false`). Its foreign keys briefly block writes to `RSVP` and `Event` | Safe. Nothing is sent until an organiser sends it |
| `20261111000100_attendance_followups` | `AttendanceCheck.organisersNotifiedAt`, `refundRequestOpenedAt` and `refundRequestId` (foreign key to `RefundRequest`) with an index | Safe |
| `20261112000000_judging_rounds` | Judging rounds (expand phase, with a backfill): new `JudgingRound`, `JudgingRoundEntry`, `JudgingRoundJudge`, `JudgingAssignmentRun` and `JudgingFinalistNotice` tables and their enums; nullable `roundId` on `JudgingCriterion`, `JudgeAssignment` and `JudgeReview` and `Event.currentJudgingRoundId`. Every event with judging data gets one "Main" round holding its rows (one `INSERT` and four `UPDATE`s over judging rows, in the migration transaction), then CHECKs keep `roundId` set and the review and assignment unique keys include the round. Triggers fill a missing round, keep round rows in their own event and mirror the event-level judging fields onto the current round | **Not safe to overlap with a release that has judging** for judge review saves; see the upgrade note below |
| `20261113000000_mentor_desk` | Mentor Desk ([MENTOR_DESK.md](MENTOR_DESK.md)): adds `MENTOR` to `EventPermission`; `Event.mentorDeskEnabled` and `mentorHelpClaimedEmail` (both default `false`); 16 new tables (mentor profiles, help categories, requests, activity and comments, assignment runs, team assignments, conflicts, office hour slots, bookings and changes, mentoring rounds, round mentors, visits, check-ins, nominations) and seven enums. Its foreign keys briefly block writes to `Event`, `Team`, `RSVP` and `User` | Safe: the desk is off on every event. Grant `MENTOR` only after the rollout |
| `20261113000100_mentor_desk_followups` | `Event.mentorsGetCrewTicket` (default `false`), `MentorConflict.createdByUserId`, `MentorProfile.crewMemberId` (unique), `MentorTeamAssignment.activatedAt` backfilled from `activeFrom` for `ACTIVE` and `ENDED` rows, then a CHECK that every `ACTIVE` row has it | Safe |
| `20261114000000_volunteer_shifts` | Volunteer shifts ([VOLUNTEERS.md](VOLUNTEERS.md)): `CrewKind` enum and a `kind` on `EventCrewMember` and `EventCrewJoinLink` (default `VOLUNTEER`), `EventCrewMember.userId`; `Event.volunteerShiftsEnabled` (default `false`) and `contributorCertificateTemplate`; `VolunteerShift`, `VolunteerShiftSignup`, `VolunteerAttendanceCorrection`, `VolunteerHours`, `VolunteerHoursEntry` and `ContributorCertificate` with CHECKs and append-only guard triggers | Safe. Existing crew members become `VOLUNTEER`; organisers can change the kind |
| `20261114000100_volunteer_followups` | `volunteer_hours_guard` also checks inserts: a new hours row must match the sign-up's counted minutes | Safe |
| `20261115000000_mobile_sessions` | Mobile API ([MOBILE_API.md](MOBILE_API.md)): `MobileSession` (token digests only); `CheckInEvent_known_source` is replaced to allow `mobile-scan` and `mobile-manual` (added `NOT VALID`, then validated in the same transaction: `CheckInEvent` stays ACCESS EXCLUSIVE during the scan); nullable manual-close columns on `Event` with the `Event_manual_close_snapshot_mode` CHECK (a scan of `Event`) | Safe: existing rows satisfy the wider list. Quiet window if `CheckInEvent` is large |
| `20261115000100_instance_google_mobile_clients` | Nullable `InstanceSetting.googleMobileClientIds` (overrides `GOOGLE_MOBILE_CLIENT_IDS`) | Safe |
| `20261115000200_mobile_refresh_history` | `MobileSession.previousRefreshTokenHashes` (GIN index, length CHECK), backfilled from `previousRefreshTokenHash`, which is dropped | Safe from 0.10.0 (the table arrives in the same release). A build that already ran `20261115000000` but not this migration fails app token refreshes until it is replaced |
| `20261115000300_mobile_idempotency` | New `MobileIdempotencyKey` table (key and body digests and small response DTOs; rows expire after a day) | Safe |
| `20261117000000_admission_permission` | Adds `REVIEW_APPLICATIONS` to `EventPermission`, alone in its migration | Grant it only after the rollout |
| `20261117010000_hackathon_admission` | Applications ([ADMISSION.md](ADMISSION.md)): admission columns on `Event` (`admissionEnabled` default `false`, `admissionMode` `MANUAL`, `admissionRsvpDays` 7, `emailApplicantsOnStageAdvance` `false`), 11 new tables and seven enums | Safe: admission is off on every event |
| `20261117020000_admission_guards` | CHECKs on the admission tables and one draft decision batch per event; triggers on `RSVP` and `Team` that open an application when a registration is made on an admission event, refuse to confirm a registration whose application has not been offered, and mark an offered application accepted when its registration is confirmed; append-only guards. The triggers take a brief SHARE ROW EXCLUSIVE lock on `RSVP` and `Team` (no scan) | Safe: the triggers act only on events with admission on, and they bind an older release's registration paths too. Turn admission on after the rollout |
| `20261117030000_admission_retention` | `AdmissionApplication.applicantKeys` and `subjectName`; applications, reviews and answer revisions are detached (`SET NULL`) instead of deleted; new `AdmissionStatusEvent` table; triggers on `RSVP` and `Team`: a delete withdraws the application, one application per person per event, registrations on an admission event start pending, and a team takes members only while its application is in review | Safe, as above |
| `20261117040000_admission_hardening` | `AdmissionAnswerRevision.personKey` (hashed, with a shape CHECK); backfills `applicantKeys` to one-way hashes and adds each registration's account and guest email keys, and `personKey` on existing revisions (UPDATEs on admission tables only, which are small); replaces the admission trigger functions (team leave/delete, touched solo applications, one application per person by any key, split indexed updates); new `BEFORE DELETE` trigger on `User` that scrubs application names and redacts answer revisions; swaps the `AdmissionStatusEvent` index for a partial unsent index. No `RSVP` or `Event` rewrite | Safe once `20261117030000` is live; old instances keep working because the triggers only tighten admission events, which only the new release can create |
| `20261118000000_reimbursement_policies` | Reimbursement policies ([FINANCE.md](FINANCE.md)): `ReimbursementEligibility` enum, `ReimbursementPolicy` and `ReimbursementNotice` tables with shape CHECKs, a trigger keeping a policy's judging or mentoring round in its event, and `NO ACTION` foreign keys so a round with a policy cannot be deleted on its own | Safe |
| `20261118010000_expense_claim_policy` | `ExpenseClaim.policyId` and `eligibilitySnapshot`, two indexes, a shape CHECK and a trigger keeping the policy in the claim's event. `ExpenseClaim` stays ACCESS EXCLUSIVE through the CHECK scan and index builds | Safe: existing claims keep a null policy and behave as before |
| `20261118020000_reimbursement_notice_rotation` | Nullable `ReimbursementPolicy.noticesCheckedAt` | Safe |
| `20261118030000_reimbursement_crew_kinds` | `ReimbursementPolicy.crewKinds` (empty means every crew member) with a CHECK | Safe |
| `20261118040000_reimbursement_admission_kind` | Adds `ADMISSION_STAGE` to `ReimbursementEligibility`, alone in its migration | Safe (the type arrives in the same release) |
| `20261118050000_reimbursement_admission_stage` | `ReimbursementPolicy.admissionStageId` (`NO ACTION` foreign key to `AdmissionStage`) and `requireAccepted` (default `false`); the stage-shape CHECK and stage trigger are replaced to cover admission stages | Safe |
| `20261119000000_judging_counted_reviews_recusal` | Nullable `JudgeAssignment.recusedAt` (judge self-recusal); nullable `JudgingRound.countedFrozenAt` with a CHECK that it is set only on a finalised round (a scan of `JudgingRound`); new `JudgingRoundCountedReview` table (the reviews a finalised round counted) cascading on `JudgingRound`. No backfill: rounds finalised earlier keep counting live | Safe |
| `20261119030000_admission_audit_fixes` | `rsvp_admission_crew_detached` trigger (`BEFORE UPDATE OF "isCrew" ON "RSVP"`, a brief SHARE ROW EXCLUSIVE lock, no scan): a registration becomes crew only once its application is detached; drops `ReimbursementPolicy.requireAccepted` (ADMISSION_STAGE policies always need an accepted application) and re-adds the stage-shape CHECK without it (a scan of the small `ReimbursementPolicy` table); `AdmissionStage.freshEyes` (default `false`) | Safe from 0.10.0: `requireAccepted` arrived in the same release, so no released build reads it |
| `20261120000000_payment_audit_fixes` | Nullable `PaymentRefund.lastCheckedAt` (provider reconciliation) and `retryOfRefundId` (a failed refund's single replacement: unique index and a `NO ACTION` self-reference); a `(status, lastCheckedAt)` index. Nullable columns, no backfill; the two index builds briefly lock `PaymentRefund` (a small table) | Safe |
| `20261120010000_utc_trigger_timestamps` | Replaces the trigger functions `rsvp_waitlist_dates`, `write_security_audit_fallback` and `write_api_security_audit_fallback` so the times they write are UTC whatever the session time zone (`CURRENT_TIMESTAMP` was stored as the session's local time). Function bodies only: no table lock, scan or backfill; rows written earlier by a database whose time zone is not UTC keep their shifted times | Safe |
| `20261120010100_storage_deletion_queue` | New enums and the `StorageDeletion` table (the stored-file deletion queue, no foreign keys) and the single-row `StorageProtocol` table holding the time this migration ran. New tables only: no lock on or scan of an existing table, no backfill | **Stop every instance of the previous release within an hour and never run it against this database again** (see [Storage deletion queue rollout](#storage-deletion-queue-rollout)) |
| `20261120010200_offline_check_in_mutations` | New `OfflineCheckInMutation` table (one row per synced offline check-in: event, client mutation id, registration, time, override and stored outcome; unique per event and id; cascades with the `Event`). No scan or backfill | Safe: instances of the previous release keep syncing without replay records until they are replaced |

Release 0.11.0 reserves the organisation addresses `/attend`, `/crew`, `/help`, `/submit` and `/team` (and `/order` and `/verify-mfa`, which 0.10.0 already served): the pre-migration check and `npm run db:verify` fail if an organisation already uses one (see [Reserved organisation addresses](#reserved-organisation-addresses)). Rename it before upgrading.

**Upgrade note (judging rounds, `20261112000000_judging_rounds`):** the migration replaces the judge review and assignment unique keys with round-scoped ones, so an instance of the previous release that is still running after the migration fails to save judge reviews (its `ON CONFLICT ("submissionId", "judgeUserId")` no longer matches an index) until the rollout completes. This only matters when the running build already has judging (`20261104010000_hackathon_judging`); release 0.10.0 has none. Close judging on events that are being judged while you upgrade, or replace instances without overlap: on Helm set `updateStrategy: {type: Recreate, rollingUpdate: null}` for this one release (the chart's default rolling update runs both releases side by side for a moment). The one-line VPS updater (`scripts/update-vps.sh`) runs the migration while the old containers still serve, then replaces them (`compose up -d --wait`), so review saves can fail only in that short window between the two steps.

**Upgrade note (admission answer revisions, `20261117040000_admission_hardening`):** that migration backfills the new `AdmissionAnswerRevision."personKey"` (`UPDATE "AdmissionAnswerRevision" v SET "personKey" = … FROM "RSVP" r WHERE v."rsvpId" = r."id" AND v."personKey" IS NULL`), but the append-only trigger `admission_answer_revision_append_only` installed by `20261117030000_admission_retention` allows only `rsvpId` to change, so the backfill fails with SQLSTATE `23514` (`AdmissionAnswerRevision rows are append-only`) when the table already holds a revision whose registration still exists. Only databases that ran the admission migrations one at a time are affected: a development or staging database that applied `20261117010000_hackathon_admission` through `20261117030000_admission_retention` and then created answer revisions (applications with edited answers) before `20261117040000` ran. A fresh install and an upgrade from 0.10.0 apply all of them in one `npm run db:deploy` with an empty table, and are not affected. The shipped migrations stay as they are (their checksums are recorded in every database that applied them). Prisma rolls the failed migration back as a whole, so nothing is half-applied. To recover a disposable database, reset it (`npx prisma migrate reset` against that database only; it deletes all data) and deploy again. Never mark the migration applied with `prisma migrate resolve --applied`: its backfill, functions and triggers would be missing. For a database whose data must be kept, mark the failed attempt rolled back (`npx prisma migrate resolve --rolled-back 20261117040000_admission_hardening`), then run `ALTER TABLE "AdmissionAnswerRevision" DISABLE TRIGGER "admission_answer_revision_append_only";`, `npm run db:deploy`, and `ALTER TABLE "AdmissionAnswerRevision" ENABLE TRIGGER "admission_answer_revision_append_only";` straight after, with no application instance running in between.

#### Storage deletion queue rollout

`20261120010100_storage_deletion_queue` starts the stored-file deletion queue ([Object storage](CONFIGURATION.md#storage-contract-and-the-deletion-queue)): from this release on, every upload records a pending deletion before it sends a byte. Instances of an older release upload without that record, so their files can be missed when an organisation is deleted. This is a **release requirement**:

1. Stop every instance of the previous release (web, worker and beat; this aborts their uploads in progress) **within one hour** of the migration. Docker Compose, the Helm rolling update, Render and the VPS updater all finish replacing instances within minutes; a canary or blue-green setup must not keep the old release serving longer.
2. **Never run an older image against this database again**, including for a rollback. Roll back by restoring the pre-migration backup instead.

The queue deletes every version and delete marker of a file, so versioning may stay on (bundled Silo keeps it on). Before upgrading an installation on Amazon S3 or another service with a versions API, give the application's access key `s3:ListBucketVersions` and `s3:DeleteObjectVersion` as well; without them its deletions fail with `AccessDenied` until they are granted, and **Super admin → Operations** reports them. Bundled Silo's policy is updated on the next start of the storage setup container. Cloudflare R2 needs nothing extra ([storage contract](CONFIGURATION.md#storage-contract-and-the-deletion-queue)).

The migration records when it ran (`StorageProtocol.enabledAt`). The listing of a deleted organisation's legacy prefix starts no earlier than 27 hours after that (the one-hour drain plus the 26-hour late-write bound), so an old upload still in flight during the rollout has settled before the listing looks for it.

#### Lock checklist

On a quiet database the whole upgrade from 0.10.0 takes well under a second. On a large or busy one:

1. Deploy at low traffic, and end long reports and `idle in transaction` sessions first:

   ```sql
   SELECT pid, state, now() - xact_start AS age, left(query, 80)
   FROM pg_stat_activity
   WHERE datname = current_database() AND xact_start IS NOT NULL
   ORDER BY xact_start;
   ```

2. Pre-build the indexes on existing columns without blocking writes. The migrations' `IF NOT EXISTS` (large-event indexes) then skips them; build `RSVP_userId_createdAt_idx` this way only when upgrading from a release before `20261018000000`, and only if that migration has not run:

   ```sql
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "RSVP_eventId_createdAt_id_idx" ON "RSVP"("eventId", "createdAt", "id");
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "RSVP_eventId_checkedInAt_id_idx" ON "RSVP"("eventId", "checkedInAt", "id");
   CREATE INDEX CONCURRENTLY IF NOT EXISTS "EventInvite_eventId_createdAt_id_idx" ON "EventInvite"("eventId", "createdAt", "id");
   ```

   A failed `CONCURRENTLY` build leaves an `INVALID` index: drop it and run the statement again before migrating.
3. Give the migration job a lock timeout, so it fails fast instead of queueing the whole site behind a long transaction. Add it to the migrator's `DATABASE_URL`/`DIRECT_URL` only (not the application's): `…?sslmode=require&options=-c%20lock_timeout%3D5s`. A migration that times out rolls back atomically; mark it with `npx prisma migrate resolve --rolled-back <migration_name>`, end the blocker, and run `npm run db:deploy` again.
4. If the job waits on a lock, find the blocker with `SELECT pid, pg_blocking_pids(pid), left(query, 80) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;` and end it (`SELECT pg_terminate_backend(<pid>);`) rather than killing the migration job, which would leave a failed migration to resolve.

## Instance-managed services

Sign in as the super admin and use `/super-admin/settings` to configure SMTP, Google SSO, and displayed backup posture. Stored SMTP and Google client secrets are write-only and encrypted at rest; retain a source-of-truth copy in the deployment secrets manager for disaster recovery. Environment values are legacy fallbacks, so migrate deliberately and verify sign-in and outbox delivery after changing their source. Panel settings are read from PostgreSQL at send and sign-in time, so they apply on every replica, in Docker, Helm, and plain Node deployments, without a restart or rebuild.

**Upgrade note (SMTP settings):** saved panel SMTP now replaces the environment as a whole. Earlier releases filled a missing saved username or password from `SMTP_USER`/`SMTP_PASSWORD`; that no longer happens, and production refuses unauthenticated SMTP unless the private-relay option is set. Before deploying, run `node scripts/check-instance-secrets.mjs`; after deploying, use **Send test email** in Super admin → Settings, and if it fails, re-enter the SMTP username and password there. **Retry failed email** requeues only failures from the last 7 days, so stale broadcasts are not resent after an outage.

`MFA_ENCRYPTION_KEY` must be identical on every replica and job, and stable. A replica with a different key stays healthy but cannot send email, sign in with Google, post alerts, verify TOTP, use organisations' payment keys and chat channels, or show station PINs. Before rotating or re-deploying, run `node scripts/check-instance-secrets.mjs` (or set `migration.checkInstanceSecrets=true` in Helm); it never prints decrypted values.

### Operational alerts webhook

The same page holds an optional **Alerts webhook**: a Mattermost (or Slack-compatible) incoming-webhook URL. When enabled, each app process posts to it:

- uncaught server errors from page renders, route handlers, Server Actions, and the proxy (Next.js `onRequestError`), with the route pattern rather than the request path;
- every server `console.error` line, and `console.warn` lines when **Include warnings** is on, which covers Next.js' own uncaught-exception and unhandled-rejection logging;
- Auth.js sign-in failures with their error type (for example `OAuthCallbackError`), outbox email delivery failures with the SMTP error code (a retried failure is a warning, a permanent one an error), and failed scheduler runs;
- browser crashes caught by the app error boundaries, through `POST /api/client-errors`;
- an *Instance started* note each time a process boots, which marks deploys and restarts.

A browser that leaves or closes a page while it is still streaming is not an error: React aborts the render with "The destination stream closed early.", which Next.js still logs (`⨯ Error: … digest: …`) and passes to `onRequestError`. Neither path turns it into an alert.

The URL embeds its own credential, so it is encrypted like the SMTP password and only its host is shown. Use **Send test message** after saving. Alert text is redacted before it leaves the instance (URLs and connection strings, email addresses, bearer values, `token=`-style parameters, and long opaque strings), identical alerts are collapsed for five minutes with a repeat count afterwards, and each process sends at most 30 alerts a minute. Delivery is best effort with a 5-second timeout and never fails the request that raised it. With several replicas, expect one *Instance started* note per replica; each process re-reads the webhook setting at most every 60 seconds, so a change saved on one replica reaches the others within a minute. Every app process needs outbound HTTPS to the webhook host.

The backup fields do not run, retain, or restore backups. Keep those controls with the database provider and record successful backups and restore drills in the instance operations area.

## Backup and incident minimums

- The repository provides database archives for operator-initiated backups and restores. Install PostgreSQL `psql`, `pg_dump`, and `pg_restore` clients compatible with the managed PostgreSQL server in the production release environment. The commands use a temporary owner-only PostgreSQL password file rather than placing the database URL/password in child-process arguments. The `backups/` directory is gitignored, must reside on encrypted host storage, and retains the newest seven complete archive pairs.
- Create a local backup from the repository directory with `npm run db:backup`. The command loads `.env` when that file is present for local operation, while explicitly injected environment values retain precedence in CI and production. It reads only `DATABASE_URL` for the database connection, requires its TLS setting, queries the live database size to require 20% plus 256 MiB of free-space headroom, and writes a compressed custom PostgreSQL archive plus a SHA-256 metadata sidecar. When `DATABASE_URL` is a transaction pooler (Supabase port 6543), run it against the session/direct connection instead: `DATABASE_URL="$DIRECT_URL" npm run db:backup` (the same applies to `db:restore`).
- To additionally copy an archive to a **dedicated private backup bucket**, pass all S3 settings only to the command (never save them in application settings or repository files):

  ```bash
  npm run db:backup -- \
    --s3-bucket spaceworks-events-backups \
    --s3-region region-name \
    --s3-endpoint https://s3.example.com \
    --s3-access-key-id short-lived-access-key \
    --s3-secret-access-key short-lived-secret \
    --s3-prefix spaceworks-events-production
  ```

  Add `--s3-force-path-style` only for providers that require it. The bucket must be private, use provider-side encryption at rest, and grant this credential only the object operations needed for the selected prefix. Prefer short-lived bucket-scoped credentials; command-line secrets can be exposed through shell history or process inspection.
- Restore is deliberately destructive. It refuses development/test databases and loopback hosts (`localhost`, `127.x`, `::1`) and requires both the parsed database name and an explicit production acknowledgement. When the loopback address is a tunnel to the production server (cloud-sql-proxy, an SSH port-forward to managed PostgreSQL), add `--via-local-tunnel`; the database-name check still applies. A refusal prints what to change; any other failure prints only "Restore failed." It creates a local safety backup before replacing data, then runs the migration status and production schema verification checks:

  ```bash
  npm run db:restore -- \
    --file backups/spaceworks-events-backup-2026-08-30T00-00-00-000Z.dump \
    --production \
    --confirm-database swevents
  ```

  To restore a remote archive, replace `--file` with `--s3-key spaceworks-events-production/spaceworks-events-backup-2026-08-30T00-00-00-000Z.dump` and supply the same required S3 options used for upload. Archives are streamed for upload and download rather than loaded into process memory; remote restores are downloaded temporarily, checksum-verified, restored, and removed from local temporary storage. Keep the provider bucket as the disaster-recovery source and perform a documented restore drill at least quarterly.

  ```bash
  npm run db:restore -- \
    --s3-key spaceworks-events-production/spaceworks-events-backup-2026-08-30T00-00-00-000Z.dump \
    --s3-bucket spaceworks-events-backups \
    --s3-region region-name \
    --s3-endpoint https://s3.example.com \
    --s3-access-key-id short-lived-access-key \
    --s3-secret-access-key short-lived-secret \
    --s3-prefix spaceworks-events-production \
    --production \
    --confirm-database swevents
  ```
- Test a point-in-time database restore every quarter and record the recovery time and data-loss window.
- Alert on failed backups, failed migrations, a stale outbox heartbeat, pending/processing email queue growth, outbox messages in `FAILED`, unavailable Redis, elevated 5xx rates, and database saturation. Treat a provider acceptance response as SMTP handoff, not inbox placement; monitor bounces and delivery events with the selected transactional-email provider.
- Rotate `AUTH_SECRET`, `CRON_SECRET`, OAuth credentials, SMTP credentials, and database credentials through the secrets manager; rehearse revocation.
- Keep an incident log, publish a security-contact address, and document breach notification responsibilities for each deployment region.

## Privacy operations

- Collect only fields necessary for each event and document the purpose/retention period.
- Users can download their own data from `/account/registrations` (`GET /api/exports/account`, audited as `ACCOUNT_DATA_EXPORTED`). Fulfil other access, correction, and deletion requests through audited administrator workflows.
- Purge expired verification tokens, old offline rosters, unused assets, and guest registration data according to the published retention policy.
- Do not place passwords, reset tokens, ticket tokens, full registration answers, or email addresses in application logs or audit metadata.
