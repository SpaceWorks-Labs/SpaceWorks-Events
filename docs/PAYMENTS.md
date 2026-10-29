# Paid tickets

Events are free by default. When an installation's super admin turns paid
events on, each organisation can sell tickets through **its own** Razorpay or
Stripe account. Buyers pay on the provider's checkout page and the money goes
straight to the organisation: the installation never receives, holds or passes
on ticket money, and adds no fee of its own.

This page is for organisers and operators. The design record is
[`docs/plans/paid-events.md`](plans/paid-events.md); the security model is in
[`SECURITY.md`](SECURITY.md).

## Turning it on (operator)

1. Super admin → **Settings** → turn **Paid events** on. Until then
   organisations can connect an account but can't sell.
2. Make sure the worker and beat run (see
   [`ARCHITECTURE.md`](ARCHITECTURE.md)): the beat releases expired holds,
   submits refunds and sends payment-link reminders; the worker sends receipts.
3. `NEXT_PUBLIC_BASE_URL` must be the public HTTPS address: webhook addresses
   and receipt links are built from it.

## Connecting an account (organisation owner)

Dashboard → **Settings → Payments** (owner only, fresh sign-in).

| | Razorpay | Stripe |
|---|---|---|
| Keys | Key id and key secret (Account & Settings → API keys) | Secret key, or a restricted key (`sk_`/`rk_`) |
| Webhook | Add the address shown on the page with a secret you choose | Add an endpoint with the address shown; copy its signing secret |
| Webhook events | `payment_link.paid`, `payment.captured`, `refund.processed`, `refund.failed`, and the `payment.dispute.*` events | `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated`, `charge.refunded`, and `charge.dispute.created`, `charge.dispute.updated`, `charge.dispute.closed` |

**Test connection** checks the keys. Test keys (`rzp_test_`, `sk_test_`)
take test payments only, and every order, report and receipt marks them as
tests. Keys and secrets are encrypted and never shown again. Each organisation
has its own webhook address, so a provider event can only settle that
organisation's orders.

Under the same page, **Receipt details** (legal name, registration number,
address) appear on every receipt.

## Selling tickets

On an event or series dashboard → **Tickets**:

- **Ticket types** with a price, capacity, sales window and per-order limits.
  - **Visibility:** public; unlocked with an access code; or members only.
  - **Pricing:** fixed, or pay-what-you-want with a suggested and maximum amount.
  - **Group tickets:** a ticket can cover several seats.
  - **Booking fee:** a per-ticket fee, shown before payment.
  - **Pay at the desk:** reserve now, pay in person.
- **Extras** (add-ons such as a T-shirt or lunch), **promo codes** (percentage or
  fixed, with limits and dates), and for series either single-date tickets or
  **passes** for every date.
- **Refund policy:** none (the organiser handles refunds), a full refund
  until a number of hours before the start, or a percentage back until then.
  The policy is shown before payment and fixed on each order.
- **Transfers:** optionally let buyers hand a ticket to someone else until a
  cut-off before the start. A ticket whose holder has expense claims waiting,
  approved or paid ([Finance](FINANCE.md)) stays with them, since claims
  belong to the registration. The new holder gets a new ticket link, and
  every link the previous holder had for that registration stops working:
  the ticket, the attendance question (reset, so the next send asks the new
  holder), the solo submission link (the project stays with the
  registration; the new holder requests a new link) and, for a team leader,
  the team page link (a new one is emailed to the new holder). An organiser
  changing a guest's email in **Edit registration** does the same
  (`retireHolderCapabilities`, `lib/rsvpHolder.ts`).

At checkout the seats are held for 30 minutes while the buyer pays. Approval
requests and waitlist places get a payment link that holds the seats for 24
hours, with one reminder a few hours before it ends. Opening the payment page
may extend a hold (up to its cap), never revive one that has ended. Extras
with a limit count toward it in confirmed orders and live holds; a request is
only held, an ended hold only reopened, and a late payment only takes its
extras back while they are still in stock. The same goes for its ticket
type's limit and its promo code's use: an ended hold's payment (or reopening
it, or re-accepting a declined request) keeps them only if they are still
free; otherwise a late payment is refunded in full and a reopen or re-accept
is refused.

**Invite-only events** sell one place per invitation: the invited person,
signed in with the invited address, buys one ticket for themselves (no group
tickets, no extra attendees). It is checked again inside the reservation, so
an event switched to invite-only, or an invitation removed, while someone was
registering is seen. Organisers can still add any guest by hand.

## Teams, entry fees, prizes and extras

- **Team events** can sell tickets: every member pays, or the leader pays once
  for the team. Team places are paid up front; rejecting a team refunds it.
  On an approval event a paid solo place waits for approval after payment,
  and approving it confirms it within the event's units (never an unpaid
  one). See [Tickets in TEAMS.md](TEAMS.md#tickets).
- **Hackathon entry fees** are paid through the same checkout when a project
  is submitted, and refunded in full on disqualification when the event says
  so. See [Entry fees](HACKATHON.md#entry-fees).
- **Prize money** paid to winners by hand is recorded in an append-only payout
  ledger by owners and admins. See [Prize money](HACKATHON.md#prize-money).
- **Check-in lists for an extra**: a list can admit only the buyers of an
  extra (lunch, a T-shirt, a workshop), as many times as each confirmed order
  bought it; its collected / eligible counts follow the quantity sold.

## After the sale

- **Receipts:** a PDF receipt for every paid order, from the order page and the
  payment email, with the organisation's receipt details and how it was paid.
- **Guest list → Payment:** settle by hand (cash, UPI, bank transfer, card
  terminal), make tickets complimentary, send a payment link, refund in part or
  in full, or cancel tickets. Refunds go back the way the buyer paid.
- **Buyers** can cancel within the refund policy from their order page.
- **Saying No to "Are you still coming?"** ([Attendance confirmation](ATTENDANCE.md)),
  when the organiser has turned on *Free the place when a guest says No*: a
  ticket on an order of its own, answered by the person who bought it, is
  cancelled exactly as the buyer would cancel it, under the refund policy frozen
  on the order (an order still owed at the desk is cancelled with its owed
  payment; nothing is refunded because nothing was paid). The email and the
  form name the refund the policy gives. Once that policy no longer allows it, the place is kept and a
  refund request is opened for the organisers, once; if the guest then says
  Yes while it is still open, it is withdrawn. An order with several tickets
  (or a team ticket paying for the whole team), or a ticket somebody else paid
  for, is never cancelled automatically: the answer is recorded, owners and
  admins are emailed and told in chat, and the guest list shows *Said No · paid*.
  The email and the form only promise a release when it would really happen.
- **Cancelling an event or a series date** refunds everyone who paid in full
  (a pass gets its share for that date) and tells every guest by email. A
  date someone on a pass already checked in to is left for the organiser to
  settle by hand. Nobody is promoted from a waitlist onto a cancelled event,
  series or date.
- **A payment that lands after a cancellation** (a delayed webhook, or a
  buyer who paid just before) never issues a ticket. It is recorded, the
  order is cancelled with its held places (a leader's unpaid team goes too;
  an entry fee's project stays a draft), and the whole amount is refunded
  automatically. The buyer is emailed that the refund is on its way (it is
  still pending at the provider then), and the organisers' chat is told.
  This covers the event, its series, and every date a pass holds. Settling
  such an order by hand is refused.
- **Chargebacks** arrive by webhook: the guest list marks the order, and the
  owners are emailed (and told in chat, if connected).
- **Refused refunds** (for example a low provider balance) are emailed to the
  owners and admins. They're listed by order under **Failed refunds** (the
  event's Finance tab, or the series page), still there after the order's
  tickets were cancelled. **Retry refund** sends a new refund for the same
  amount: owners and admins only, after an authenticator check and a recent
  sign-in (`retryFailedRefundAction`). The failed refund is kept as it is;
  the new one points at it (`PaymentRefund.retryOfRefundId`, unique, so a
  failed refund is retried once even by two people at once), and the
  database guard still refuses anything over what is left on the payment.
  Only the provider definitely refusing to *create* a refund fails it. A
  refund whose first answer was lost is looked up before it is sent again,
  and a lookup that fails in any way (a timeout, or a refusal such as 401
  while the keys are wrong) leaves it pending with its money still committed,
  so it can't be retried into a second refund.
- **Refundable orders**: a cancelled order refunded in part (a partial
  refund under the policy) or the expired order of a payment that arrived
  late can still have money on it. The Finance tab (and the series page)
  lists cancelled and expired orders with money left, whether or not a refund
  failed, and owners and admins refund what is left from there, by order,
  after an authenticator check and a recent sign-in (`refundEndedOrderAction`).
  It works after the order's tickets are gone and refunds money only. It also
  lists confirmed orders on cancelled events, series or dates, including orders
  with checked-in guests: refund them here without cancelling their tickets or
  removing attendance records. Return cash yourself before recording an in-person
  refund. For a pass, enter the cancelled date's share; leaving the amount blank
  returns the whole remaining balance. While a checked-in place remains on a
  cancelled date, any remaining pass balance still blocks organisation deletion;
  refund the rest before deleting. Other confirmed orders use the guest list.
  Balances are calculated before the newest 100 refundable orders are selected,
  so fully refunded orders never hide older money. After refunding these orders,
  the list refreshes to show the next ones, independently of guest registrations.
- **Refunds the provider accepted but never finished**: when a refund has the
  provider's id but no final webhook came, the minute's maintenance asks the
  provider about it once it is an hour old, 25 at a time, least recently
  checked first (`PaymentRefund.lastCheckedAt`). A finished or failed answer
  settles it (a failure is told to the organisers once); a timeout or an
  unreadable answer leaves it pending for the next pass. Maintenance never
  creates a provider refund. Razorpay refunds are created with its
  `X-Refund-Idempotency` header (a key made from our refund id), Stripe's
  with an `Idempotency-Key`, and the lookup before a retry reads every page of
  the payment's refunds (Razorpay by offset; Stripe by cursor, `has_more` and
  `starting_after`); a lookup it can't finish, or a malformed page, counts as
  unknown, never as "no refund yet".

### In the mobile apps

The Space Works apps sell the same tickets ([Mobile API](MOBILE_API.md)): a
paid registration answers `PENDING_PAYMENT` with the order id and the hosted
checkout, opened in the system browser, and is never a ticket until the
provider's webhook confirms it. Signed-in buyers reach their orders by id (the
access token is never sent to the app) to pay, cancel under the refund policy,
ask for a refund, download the receipt and transfer tickets. Organisers with
`MANAGE_REGISTRATIONS` settle at the desk, resend payment links and refund;
the check-in preview shows what is owed.

## Reporting

- **Event Analytics** and the **series dashboard** show a Money card: collected,
  refunded, net, by ticket and by payment method, plus desk money, holds,
  complimentary tickets and chargebacks. **Download orders (CSV)** exports every
  order.
- **Test payments** (taken online while the account uses test keys) moved no
  real money: they, their refunds and chargebacks are left out of every
  money figure (Money cards, the organisation dashboard, the PDF report and
  the Finance tab) and shown apart, labelled as test payments. Money recorded
  as collected in person always counts.
- The **organisation dashboard** shows six months of takings per currency.
- The PDF event report has a Money section.
- The machine API has an `orders:read` scope (`GET /api/v1/events/:id/orders`),
  totals only.
- Buyers' orders and refunds are in their personal data export.

## Notes for operators

- The installation is not a party to any sale. Review the terms (`/terms`,
  "Free events and paid tickets") and privacy policy (`/privacy`) for your
  jurisdiction before turning paid events on.
- Card, UPI and bank details never reach the installation; only the provider's
  payment reference and a short method description (for example the card brand
  and last four digits) are stored.
- Deleting an event or series is refused while people have paid for it:
  cancel it instead, which refunds them. Deleting an organisation is refused
  while people have paid for something still to come, while a buyer is still
  paying, while any refund is still on its way, and while a refund the
  provider refused is still owed (retry it first), whatever the event's or
  order's state: deleting would erase the payment records and settings those
  need. Cancelled events, series and dates with a collected balance also block
  deletion, even before the first refund is recorded and after the event ends.
  Resolve them from **Refundable orders**, including checked-in orders. Cancelled
  events and series with such balances cannot be deleted separately either.
  Nothing is announced or removed when deletion is refused.

## Locks and races (developers)

Every transaction that touches seats, orders or money takes its row locks in
one order, so two of them never wait on each other:

0. the organisation fence: `FOR KEY SHARE` on the Organisation row
   (`fenceOrganisation` in `lib/payments/targets.ts`), first in every path
   that may create an order or a payment (reservations and manual ticket
   orders through `lockSellable`, entry fees, settlement, everything through
   `lockOrder`, accepting an application's paid offer through
   `lockAdmissionEvent`) and in event and series deletion. Key-share locks
   never block each other; within this order/payment lock protocol,
   organisation deletion is the only operation taking Organisation `FOR UPDATE`;
1. the event row, or the series row;
2. the series' dates, by id;
3. the order;
4. its payments, by id;
5. its registrations (RSVPs), by id, including a PER_TEAM leader's whole team;
6. attendance check rows.

Rules that go with it:

- Refund writes lock the Payment first (`lockRefundPayment` in
  `lib/payments/refunds.ts`): the ledger trigger locks the Payment after any
  `PaymentRefund` write, so writing the refund row first would take the two
  in the opposite order. Submission claims, provider results, webhooks and
  reconciliation all follow it.
- A provider is never called inside a database transaction. Refunds are
  recorded PENDING under the locks and submitted after commit.
- A notice (email, chat, audit) for a refund or a release goes out only when
  the conditional update it describes changed a row.
- A cancellation locks the registrations before reading their check-in, and
  deletes only rows still not checked in; a count that doesn't match throws,
  rolling the whole cancellation back. A scan either commits first and the
  cancellation is refused, or waits and finds the ticket gone. Organisers
  deleting a checked-in guest is unchanged.
- Cancelling a pass's date is one transaction per order: the share is worked
  out, recorded and the date's places removed together, so a retry finds
  nothing left to refund.
- Extending a hold takes the event (or series and dates) locks before the
  order and reads the time after them. Settlement (provider notifications,
  the return page, maintenance closing a paid page) and settling by hand do
  the same: the timestamp taken before the provider call only stamps the
  payment; whether the hold is still live, and so whether places, extras,
  the ticket type and the promo code must be counted again, is read under the
  locks.
- An ended hold coming back (late payment, settling by hand) checks extras,
  ticket-type limits and the promo code's limit before a team place is
  touched, so a refused one leaves nothing changed. On a TEAM event the
  ticket type is checked apart from the event's units.
- Promo code limits are read under the event or series lock that every order
  on the code takes first (`promoStillFits` in `lib/payments/promo.ts`).
- Cancellation takes the organisation fence before the event or series and date
  locks. The saved CANCELLED status (or a date's cancelledAt) together with its
  collected balance is the durable refund obligation, committed atomically with
  cancellation; no separate refund row is needed for deletion to see it. A pass's
  date registrations stay attached until their refund share and removal commit
  together. Checked-in places stay attached for money-only manual refunds.
- Organisation deletion is one transaction: the Organisation row
  `FOR UPDATE`, then what is still owed (`organisationMoneyBlocker` in
  `lib/payments/obligations.ts`), then the notices, the audit record, the
  storage queue and the delete. A reservation that holds the fence first
  commits and is seen; one that comes after waits and finds the organisation
  gone. Event and series deletion take the fence and the event or series
  lock, then check paid orders again.
- Other Event-locked paths can later write Organisation-referencing rows
  (for example Mentor Desk audits or outbox messages) without taking the
  Organisation fence first. These can deadlock with concurrent organisation
  deletion's cascade. PostgreSQL resolves the cycle by aborting one transaction;
  deletion retries the whole transaction, including the obligations check,
  up to three attempts in total on Prisma `P2034` or PostgreSQL `40P01`/`40001`.
  Notices, audit and storage queue writes all stay inside that transaction,
  so aborted attempts leave no duplicate side effects; cache revalidation
  runs only after a successful deletion.
- Membership role changes and removals serialise on the Organisation row
  (`FOR NO KEY UPDATE`, which never blocks the fence, and waits for leaving,
  which takes `FOR UPDATE`), re-read both people's roles under it, and
  change only a row still in the role that was checked.
- Capacity edits count confirmed places and live holds with the time read
  under the series lock; clearing a date's own capacity checks the series
  capacity it would inherit.
- A release started by an attendance "No" (free cancellation, paid
  cancellation, refund request) runs only while that exact No is still the
  answer (`lockCurrentNo` in `lib/attendanceGuard.ts`, the last lock taken).
- A transfer locks the holder's registrations (by id, after the event or
  dates) before reading their check-in, and each write still expects an
  unused, confirmed ticket: a scan either commits first and the transfer is
  refused, or waits for it. The attendance check is deleted in the same
  transaction, so a "No" the old holder answered before the transfer finds
  no current answer and releases nothing. Organiser email changes and the
  buyer's attendee edits take the same event-then-registrations order.
- Ticket-token cancellation rechecks the supplied token and the caller's
  account ownership under the registration lock. Its writes retain those
  conditions, so a cancellation waiting behind a holder change cannot remove
  the replacement holder's place, including a free ticket on an order.

## Applications

On events taking applications ([ADMISSION.md](ADMISSION.md)) a paid registration places a REQUESTED order and nothing is charged. An offer leaves the order REQUESTED; the applicant's **Accept and pay** holds the place for a day through the payment-link path (`offerInTransaction`; the PER_TEAM leader's order holds the team's unit), and the settled payment confirms it. A place is never confirmed unpaid (database guard `admission_status_guard`). A hold that ends unpaid puts the order back to REQUESTED while the offer's respond-by time lasts, then the offer expires and the order is CANCELLED; a decline, withdrawal or rejection cancels the unpaid order. A free ticket type on a paid event is free for that applicant. Orders are one seat each on these events, and PER_MEMBER paid team events can't take applications yet.
