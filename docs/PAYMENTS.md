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
  cut-off before the start.

At checkout the seats are held for 30 minutes while the buyer pays. Approval
requests and waitlist places get a payment link that holds the seats for 24
hours, with one reminder a few hours before it ends.

## Teams, entry fees, prizes and extras

- **Team events** can sell tickets: every member pays, or the leader pays once
  for the team. Team places are paid up front; rejecting a team refunds it.
  See [Tickets in TEAMS.md](TEAMS.md#tickets).
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
  (a pass gets its share for that date) and tells every guest by email.
- **Chargebacks** arrive by webhook: the guest list marks the order, and the
  owners are emailed (and told in chat, if connected).
- **Refused refunds** (for example a low provider balance) are emailed to the
  owners and admins so they can retry or refund another way.

## Reporting

- **Event Analytics** and the **series dashboard** show a Money card: collected,
  refunded, net, by ticket and by payment method, plus desk money, holds,
  complimentary tickets and chargebacks. **Download orders (CSV)** exports every
  order.
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
- Deleting an organisation, event or series is refused while people have paid
  for something still to come: cancel it instead, which refunds them.
