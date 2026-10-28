# Future phases

[Documentation index](README.md)

This page contains only work that is not currently implemented. Current behavior belongs in [Features](FEATURES.md).

## Security and assurance

- Replace email-knowledge certificate eligibility with one-time inbox verification when certificates carry value or personal data.
- Expand automated coverage for every Server Action, role boundary, cross-tenant access attempt, and failure/rollback path.
- Add automated SAST, secret scanning, container scanning, and a documented vulnerability-disclosure policy.
- Commission an independent penetration test and threat-model review before handling sensitive or regulated data.
- Add optional step-up authentication for especially destructive organiser and super-admin operations.

## Attendance confirmation

- Ask series dates and pass holders "Are you still coming?" (an instance-scoped check, a per-date Emails card and counts). Today only one-off events are asked.
- Release one ticket of a paid order with several tickets (a partial cancellation with its share of the refund). Today such a No is left to the organisers.
- Sending the attendance question and reminders from the mobile app (answering, counts and shared links are in the mobile API). Nothing sends the question automatically, and that stays a deliberate choice unless organisers ask for it.

## Privacy and account lifecycle

- Self-service account deletion and correction beyond profile name/photo.
- Audited organiser exports with purpose/approval recording.
- Configurable tenant-level retention policies for registrations, feedback, and audit history.
- Consent and policy-version records where legally required.

## Product expansion

- Scheduled reminders, delivery preferences, and unsubscribe management for attendee communications.
- Calendar feeds and external calendar synchronization.
- Cross-event and organisation-level analytics with privacy-preserving aggregation.
- Organisation branding and custom domains.
- More granular custom roles and per-action permissions.
- Import/export tools for events and attendee rosters.
- Team registration for recurring series and occurrences (today series stay individual and their validators refuse team settings).
- Team support in the machine API (team rosters behind a separately scoped credential). Today no API DTO has team fields.
- Email notifications for team invitations and join requests (today they appear only on the team and ticket pages).
- Hackathon judging in the machine API (published results behind a separately scoped credential). Today the machine API exposes no submissions, judging, or results.
- Hackathon events in the organisation webhook catalogue ([Organisation webhooks](WEBHOOKS.md)), for example `submission.submitted`, `submission.withdrawn`, and `results.published`. Each needs a new event type in `lib/webhooks/eventTypes.ts`, a minimal payload builder (project title and entrant display name only, never scores, judge comments, or the disqualification reason), commit-point emission from `lib/core/judging.ts`, the endpoint form's type list, and tests, so it was left out of the first judging release.
- Extend the machine API only for concrete consumers: recurring series/instances, RSVP workflow data, separately scoped participant contact or registration answers, privacy-preserving feedback reads, and narrow idempotent writes.

## Deferred from Yuyu sync 3

- Paying per member on a team event taking applications ([Applications](ADMISSION.md)). Today paid team places with applications use PER_TEAM (the leader pays once); per-member payment needs an all-or-nothing gate (every member held until the last pays, the team confirmed at once, all refunded at the deadline).
- Space Works' award and reservation reimbursement flow (offer, accept, reserve from a pool; [Finance](FINANCE.md)). Today reimbursements are policies people claim against.
- The native Android and iOS apps. The [mobile API](MOBILE_API.md), its OpenAPI contract and the app links are ready for them.
- A server nonce for mobile Google sign-in ([Mobile API](MOBILE_API.md)). Today the ID token's short life and the `azp` check bound replay.

## Scale and reliability

- Load and soak testing with documented capacity targets.
- Queue-depth, latency, object-store, and email-delivery service-level objectives.
- Multi-region/read-replica planning if real traffic requires it.
- Automated restore verification and disaster-recovery exercises.

## Documentation rule

Move an item from this file to the appropriate current-state document only after the code, migrations, tests, configuration, and operational requirements are complete.
