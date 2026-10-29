# Event finance

Each event's money in one place: what came in, what went out, and the
budget. The event dashboard's **Finance** tab (`?tab=finance`) holds it. The
parts are expense claims, the claim payout ledger, refund requests, and the
event budget. Prize money for hackathon awards is in
[Hackathon](HACKATHON.md#prize-money); ticket money is in
[Paid tickets](PAYMENTS.md).

## Who can do what

| | Owners and admins | Members and co-organisers (any grant) | Registered participants |
| --- | --- | --- | --- |
| File an expense claim | Yes | Yes (their own) | From the ticket page, when the event allows it (crew: with *Let crew claim expenses*) |
| See claims | Every claim | Their own | Their own, on the ticket page |
| Withdraw a claim before it is decided | Their own | Their own | Their own |
| Approve, reject, record payment, reverse a payment | Yes | — | — |
| Budget and participant-claim settings | Yes | — | — |
| Reimbursement policies (create, edit, close, delete) | Yes | — | Claim under the ones open to them, from the ticket page |
| Refund requests (decide) | Yes | — | Ask, from the order page |
| Money summary and **Download CSV** | Yes | — | — |

Any event grant counts as a co-organiser here, the isolated JUDGE, MENTOR
and REVIEW_APPLICATIONS grants included: they file and withdraw their own
claims on that event only (on the website below their workspace, in the app
under `fileClaims`), and see nobody else's.

There is no new co-organiser grant: deciding money is an owner/admin
matter, like prize payouts and payment settings. Every step is audited.

## Expense claims

- A claim has a category (travel, accommodation, food, venue, equipment,
  printing, marketing, supplies, other), details (up to 1000 characters), an
  amount in the event's currency, and up to three receipt photos.
- **Staff** (organisation members and co-organisers, from the Finance tab)
  claim for themselves or on behalf of someone else, such as a speaker or a
  volunteer, by giving that person's name and email; the person being paid
  back gets the emails. Any event co-organiser grant qualifies, including a
  mentor-only `MENTOR` grant ([Mentor Desk](MENTOR_DESK.md)): the server
  accepts their claim for that one event only (`canViewEventDashboard` on the
  event), and they withdraw only their own claims. The mentor console does not
  show the claim form yet; deciding and paying stays with owners and admins.
- **Participants** claim from their ticket page (travel grants) when the
  event turns on *Let confirmed participants claim expenses*, only while
  their registration is confirmed, and up to the optional cap per person.
  Waiting claims count at the amount asked, decided ones at the amount
  approved; rejected and withdrawn ones don't count. The cap is checked under
  the event row lock, so two claims can't both slip under it. The ticket token
  is the proof; an account-owned ticket also needs that account signed in.
  Claims belong to the registration, so a ticket with claims waiting,
  approved or paid can't be transferred ([Paid tickets](PAYMENTS.md)).
- **Crew** ([Event crew](CREW.md)) claim from their crew ticket page when
  the event turns on *Let crew claim expenses* (`Event.crewClaimsEnabled`,
  off by default), as kind `CREW`, with no cap; the participant switch and
  cap don't apply to them. The Finance list labels them *(crew)*.
- Lifecycle: `SUBMITTED` → `APPROVED` (for the amount asked or less, with an
  optional note) or `REJECTED` (with a reason the claimant sees) →
  `PAID`. The claimant may withdraw (`WITHDRAWN`) while it waits: staff only
  their own claims on the organisation and event of the route they use
  (`withdrawClaim` matches all three), a participant only claims of the
  registration their ticket proves. Each step locks the claim row.
- Emails (operator notices through the outbox): owners and admins when a
  claim arrives; the person being paid back when it is approved, rejected or
  paid. Chat: *Expense claims* for claims and refund requests, *Payouts* for
  payments.
- Audit actions: `EXPENSE_CLAIM_SUBMITTED`, `EXPENSE_CLAIM_WITHDRAWN`,
  `EXPENSE_CLAIM_APPROVED`, `EXPENSE_CLAIM_REJECTED`, `CLAIM_PAYOUT_RECORDED`,
  `CLAIM_PAYOUT_REVERSED`, `EVENT_FINANCE_UPDATED`, `EVENT_FINANCE_EXPORTED`.

## Reimbursement policies

Per-stage reimbursements (travel grants for finalists, mentored teams, crew,
or everyone confirmed) on free and paid events alike: a claim never depends
on ticket payment, only on a confirmed registration. The Finance tab's
**Reimbursement policies** card lists each policy with who it is for, its
cap, window, budget used and left, and claim count; owners and admins
create, edit, close (**Close to new claims**) and delete them
(`lib/claims/policies/manage.ts`, under the event row lock, audited
`REIMBURSEMENT_POLICY_CREATED`, `_UPDATED`, `_CLOSED`, `_REOPENED`,
`_DELETED`). Up to 20 per event.

- A policy (`ReimbursementPolicy`) has a name, who may claim
  (`eligibility`), a cap per person, the categories it covers, an optional
  claim window (event time), *only people checked in*, an optional budget for
  the whole policy, an active switch and an optional *email people when they
  can claim*.
- Who may claim, one resolver per kind in `lib/claims/policies/eligibility/`
  (a registry: a new kind adds its enum value, its stage column and CHECK,
  and one resolver):
  - `CONFIRMED_PARTICIPANT`: every confirmed participant who is not crew.
  - `CREW`: every confirmed crew member ([Event crew](CREW.md)), or only
    those of the crew kinds the policy names (`crewKinds`, for example
    volunteers only; empty is every crew member; a CHECK keeps kinds to
    `CREW` policies).
  - `JUDGING_ROUND_ENTRY` (`judgingRoundId`, a round that takes advanced
    projects): the person's team's project, or their own when solo, has a
    `JudgingRoundEntry` in the round and is not withdrawn or disqualified;
    optionally only once the round's finalists are published.
  - `MENTORING_ROUND` (`mentoringRoundId`): the person's team took part in
    the Mentor Desk round (a submitted, non-away check-in, Mentor Desk's own
    `tookPartInRound`). Solo participants never qualify.
  - `ADMISSION_STAGE` (`admissionStageId`, on an event taking applications,
    [Applications](ADMISSION.md)): the person's application (their team's for
    a team member, their own when solo) reached the stage, by Admission's
    own `applicationReachedStage`, and is ACCEPTED. Applicants in review,
    waitlisted or offered never qualify; a withdrawn, declined, expired or
    rejected application no longer qualifies, also at approval. An admission
    stage a policy is for can't be deleted.
  Every kind needs a confirmed registration, and a check-in when the policy
  asks for attendance. A CHECK keeps exactly the kind's stage id set and a
  trigger keeps the stage in the policy's event. Who a policy is for is fixed
  once claims are filed under it; a claimed policy can be closed but not
  deleted (`ExpenseClaim.policyId` is NO ACTION), and a judging round a
  policy uses can't be deleted.
- **Filing** (ticket page, or the mobile app with `policyId`): the claim form
  lists only the policies open to that person now, each with what is left for
  them (the smaller of their cap and the policy's budget), and limits the
  categories to the policy's. Under the event row lock the server checks the
  policy is active and in its window, the category, eligibility, the cap per
  person per policy (waiting claims at the amount asked, decided ones at the
  amount approved) and the policy budget (waiting plus approved). The
  policy's terms are frozen into `ExpenseClaim.eligibilitySnapshot` with the
  eligibility facts (ids, statuses and flags only), so a later policy edit
  never rewrites them. Policy claims are kind `PARTICIPANT` or `CREW`.
- **Approving** re-checks, under the event lock: the person must still
  qualify by the frozen terms (eligibility is decided at decision time); the
  total approved for them under the policy, this approval included, must not
  exceed the highest of the caps those approved claims were filed under and
  the policy's current cap (so the order in which claims are approved never
  changes the outcome after a cap change); and the policy must stay within its
  current budget. The approval check is added to the snapshot.
  Waiting claims whose person no longer qualifies (a check-in undone, a
  project disqualified or withdrawn) show **Eligibility changed since
  submission** with the reason; they can be rejected. The claims list shows
  each claim's policy and filters by it.
- **Email** (optional, per policy, off by default): the beat's
  `reimbursement-notices` job (every 5 minutes) queues
  `reimbursement-available` once per person and policy
  (`ReimbursementNotice`, row lock per policy) when the policy is open and
  the person qualifies, for example once finalists are published or their
  team has been mentored. Each pass takes up to 50 policies, those checked
  longest ago first (`noticesCheckedAt`), so every policy gets its turn. The
  payload holds ids only; at send time the policy and the person's
  eligibility are checked again and the ticket link is built. A message
  dropped then (the policy closed, the person no longer qualifies) clears its
  notice, so they are told if it applies to them again.
- General participant claims (`participantClaimsEnabled`, its cap) and crew
  claims (`crewClaimsEnabled`) work exactly as before; the general cap counts
  only claims without a policy. Policy claims don't need either switch, and
  general and policy caps add up: a person may claim up to the general cap and,
  separately, up to each policy's cap.
- Caps are per registration, as for general claims: a person who cancels and
  registers again, or holds both a guest and an account registration, starts
  each registration's caps afresh. Policy budgets still bound the total. Deleting the event keeps its claims (their
  policy link is cleared; the terms stay in the snapshot).
- Webhook: `expense_claim.status_changed` ([Webhooks](WEBHOOKS.md)) on filing,
  withdrawal, approval, rejection, payment and reversal, with ids and amounts
  only.
- Not included: Space Works' award and reservation flow (offer, accept,
  reserve from a pool), which could be a later phase.

## Receipts

- Photos (JPEG, PNG or WebP, under 5 MB in all: the Server Action body limit is 6 MB) are checked, decoded under the pixel
  limit, stripped of metadata and re-encoded as WebP, like cover images
  (`createSafeWebpDerivative`).
- They are stored privately under `organisations/{id}/claim-receipts/`
  (`lib/storage/private.ts`, `Cache-Control: private, no-store`), never through
  `/api/uploads`, which serves only public derivatives.
- `GET /api/claims/receipts/:receiptId` serves one to the organisation's
  owners and admins and to the signed-in person who filed the claim; every
  denial is the same empty 404. A database CHECK keeps receipt keys under the
  private prefix.

## Claim payout ledger

- Paying an approved claim records a `ClaimPayout` for the approved amount:
  how it was paid (cash, UPI, bank transfer, card terminal, other), a
  reference, the day and a note. The claim becomes `PAID`.
- The ledger is append-only, guarded by database triggers like
  `PrizePayout`: a row never changes except that a reference is cleared when
  what it points at is deleted, and a mistake is undone by a **reversal** row
  for the same amount and currency (at most one per payout). Reversing puts
  the claim back to `APPROVED`. Rows are never deleted, except with their
  organisation (a BEFORE DELETE trigger).

## Refund requests

- On a paid order's page (bearer order link), a buyer can ask for a refund
  outside the automatic policy (or for more than it gives), with a reason.
  One open request per order (partial unique index). Owners and admins are
  emailed.
- An owner or admin **approves**, choosing an amount (blank refunds everything
  still refundable) and whether to cancel the tickets: this runs the normal
  `refundOrder`, so refunds go back the way the buyer paid and team rules
  apply. The request is claimed before the refund runs and released if the
  refund is refused before it commits (only while it is still that approval;
  a request opened by an attendance "No" whose guest has since said Yes is
  withdrawn instead); once a refund has committed, the request stays
  approved, so two approvals never refund twice. Or they **decline**
  with a reason the buyer sees. Audited `REFUND_REQUESTED`,
  `REFUND_REQUEST_APPROVED`, `REFUND_REQUEST_DECLINED`.
- **Failed refunds**: a refund the provider refused is listed by order on the
  Finance tab (and the series page) for owners and admins to retry once,
  after a recent sign-in. See [Refused refunds in PAYMENTS.md](PAYMENTS.md#after-the-sale).

## Summary, budget and export

- **Income**: money collected for tickets and entry fees, less committed
  refunds. **Expenses paid** and **prize money paid** are net of reversals.
  **Net** is income less both. Approved claims not yet paid and waiting
  claims are shown beside expenses.
- **Test payments** (taken online with the payment account's test keys) are
  left out of income and net: a separate note shows how many there were and
  their total after refunds, and the CSV marks their rows "(test)". Money
  recorded as collected in person always counts as real.
- **Refundable orders**: cancelled or expired orders with money left on them,
  refunded by order by owners and admins. See
  [Refunds in PAYMENTS.md](PAYMENTS.md#after-the-sale).
- The optional **budget** (`Event.budgetMinor`) is compared with what is
  spent or approved (paid claims, approved claims and prize money).
- **Download CSV** (`GET /api/exports/events/:eventId/finance`, owners and
  admins, audited) lists every money movement, oldest first: payments in,
  refunds, claim payments and prize payouts, reversals included, signed from
  the organisation's side.
- The PDF event report's Money section gains *Spending*: claims and prizes
  paid, approved but unpaid, the budget, and the net after spending.

## In the mobile apps

Participants file and withdraw claims from a registration with receipt photos
(under a reimbursement policy with `policyId`, listed by
`GET …/reimbursements`) and see their decisions; staff file and withdraw their own; owners and admins
see every claim and refund request and approve, decline or decide them
([Mobile API](MOBILE_API.md)). Payouts, the budget and participant-claim
settings stay on the website. Decisions from the app are held to the event in
the path.

## Tests

- PostgreSQL suite `tests/integration/finance.db.test.ts`: a staff claim with
  a private receipt approved in part, paid, refused by the payout trigger,
  reversed; participant claims refused when off, capped, and counted after a
  rejection; refund requests asked once, declined only with a reason,
  approved in part (one refund), never twice.
- `tests/integration/payment-final-flows.db.test.ts`: a test payment is left
  out of income, net and the Money card's collected and shown apart, while
  cash recorded at the desk counts; `tests/unit/payment-revenue.test.ts`
  covers the same split in the revenue summary.
- `tests/integration/payment-final-refunds.db.test.ts`: money left on a
  cancelled order after a partial refund is listed and refunded once, by
  owners and admins only.
- `tests/unit/reimbursement-policies.test.ts`: cap and budget arithmetic, the
  frozen snapshot, and each eligibility resolver.
- `reimbursements-claims.db.test.ts`, `reimbursements-eligibility.db.test.ts`,
  `reimbursements-admin.db.test.ts`: see [Testing](TESTING.md).
