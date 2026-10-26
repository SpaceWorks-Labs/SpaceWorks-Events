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
| File an expense claim | Yes | Yes (their own) | From the ticket page, when the event allows it |
| See claims | Every claim | Their own | Their own, on the ticket page |
| Withdraw a claim before it is decided | Their own | Their own | Their own |
| Approve, reject, record payment, reverse a payment | Yes | — | — |
| Budget and participant-claim settings | Yes | — | — |
| Refund requests (decide) | Yes | — | Ask, from the order page |
| Money summary and **Download CSV** | Yes | — | — |

There is no new co-organiser grant: deciding money is an owner/admin
matter, like prize payouts and payment settings. Every step is audited.

## Expense claims

- A claim has a category (travel, accommodation, food, venue, equipment,
  printing, marketing, supplies, other), details (up to 1000 characters), an
  amount in the event's currency, and up to three receipt photos.
- **Staff** (organisation members and co-organisers, from the Finance tab)
  claim for themselves or on behalf of someone else, such as a speaker or a
  volunteer, by giving that person's name and email; the person being paid
  back gets the emails.
- **Participants** claim from their ticket page (travel grants) when the
  event turns on *Let confirmed participants claim expenses*, only while
  their registration is confirmed, and up to the optional cap per person.
  Waiting claims count at the amount asked, decided ones at the amount
  approved; rejected and withdrawn ones don't count. The cap is checked under
  the event row lock, so two claims can't both slip under it. The ticket token
  is the proof; an account-owned ticket also needs that account signed in.
- Lifecycle: `SUBMITTED` → `APPROVED` (for the amount asked or less, with an
  optional note) or `REJECTED` (with a reason the claimant sees) →
  `PAID`. The claimant may withdraw (`WITHDRAWN`) while it waits. Each step
  locks the claim row.
- Emails (operator notices through the outbox): owners and admins when a
  claim arrives; the person being paid back when it is approved, rejected or
  paid. Chat: *Expense claims* for claims and refund requests, *Payouts* for
  payments.
- Audit actions: `EXPENSE_CLAIM_SUBMITTED`, `EXPENSE_CLAIM_WITHDRAWN`,
  `EXPENSE_CLAIM_APPROVED`, `EXPENSE_CLAIM_REJECTED`, `CLAIM_PAYOUT_RECORDED`,
  `CLAIM_PAYOUT_REVERSED`, `EVENT_FINANCE_UPDATED`, `EVENT_FINANCE_EXPORTED`.

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
  refund is refused before it commits; once a refund has committed, the
  request stays approved, so two approvals never refund twice. Or they **decline**
  with a reason the buyer sees. Audited `REFUND_REQUESTED`,
  `REFUND_REQUEST_APPROVED`, `REFUND_REQUEST_DECLINED`.

## Summary, budget and export

- **Income**: money collected for tickets and entry fees, less committed
  refunds. **Expenses paid** and **prize money paid** are net of reversals.
  **Net** is income less both. Approved claims not yet paid and waiting
  claims are shown beside expenses.
- The optional **budget** (`Event.budgetMinor`) is compared with what is
  spent or approved (paid claims, approved claims and prize money).
- **Download CSV** (`GET /api/exports/events/:eventId/finance`, owners and
  admins, audited) lists every money movement, oldest first: payments in,
  refunds, claim payments and prize payouts, reversals included, signed from
  the organisation's side.
- The PDF event report's Money section gains *Spending*: claims and prizes
  paid, approved but unpaid, the budget, and the net after spending.

## Tests

- PostgreSQL suite `tests/integration/finance.db.test.ts`: a staff claim with
  a private receipt approved in part, paid, refused by the payout trigger,
  reversed; participant claims refused when off, capped, and counted after a
  rejection; refund requests asked once, declined only with a reason,
  approved in part (one refund), never twice.
