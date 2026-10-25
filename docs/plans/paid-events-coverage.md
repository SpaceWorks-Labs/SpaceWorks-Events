# Paid events: covering every kind of paid event (addendum to paid-events.md)

The owner asked on 2026-10-20 that paid events cover every kind of paid event.
This addendum extends `paid-events.md`, and wins where the two differ.

It comes from research into Eventbrite, Luma, Ti.to, KonfHub, Meetup, the
Razorpay and Stripe documentation, and the Indian GST rules (CGST Rule 46).
Sources are listed at the end.

## 1. Fixes to the current design (do these first)

1. **One checkout attempt per link.** Razorpay's `reference_id` must be unique
   for every payment link, so "Pay now" retries fail if it is the payment id.
   - Add `PaymentCheckoutAttempt`: `id`, `paymentId`, `provider`,
     `externalId` (unique per provider), `url`, `expiresAt`, and
     `status OPEN|PAID|EXPIRED|CANCELLED`.
   - Use the attempt id as Razorpay `reference_id` and Stripe
     `client_reference_id`.
   - Webhooks match by the attempt's external id, then go to its payment.
   - When a hold expires, every open attempt is cancelled first.
2. **Holds respect provider minimum expiries.** Stripe Checkout needs at least
   30 minutes and at most 24 hours; Razorpay links need at least 15 minutes.
   - A new attempt extends the hold to the provider minimum plus 2 minutes,
     with a hard cap of 60 minutes in total.
   - For the 24-hour approval and waitlist holds, create the checkout only
     when the person clicks **Pay**, with expiry = min(hold, now + 24 h).
3. **Orders.** One payment per RSVP cannot sell several tickets in one go.
   - Add `Order`: `organisationId`, `eventId?` or `eventSeriesId?`, buyer
     (user or guest email and name), `status`, `currency`, totals in minor
     units, `holdExpiresAt`, and a frozen refund policy.
   - Add `OrderLine`: `kind TICKET|ADD_ON|FEE`, `ticketTypeId?`, `addOnId?`,
     `quantity`, `unitMinor`, `discountMinor`, `taxableMinor`, `taxMinor`
     (plus the CGST, SGST and IGST split), and `taxRateBps`; the tax columns
     stay zero, since no tax is computed (see §4, Receipts).
   - `RSVP.orderId` creates one RSVP per attendee. Each RSVP gets its own
     registration answers. Missing attendee details are chased by an outbox
     email.
   - `Payment` belongs to `Order`, and one order can have several payments
     (instalments later).
   - `TicketType` gains `minPerOrder` and `maxPerOrder`.
4. **Provider limits.** Reject a non-zero total, after discounts, below the
   provider minimum (Razorpay ₹1, Stripe ₹0.50). Warn organisers that UPI
   generally stops at ₹1 lakh per payment.
5. **One currency per event.** Store it as `Event.currency` (or the series
   currency), locked after the first sale. Every ticket type, add-on and
   fixed-amount code must match it.

## 2. Event shapes

| Shape | Design |
| --- | --- |
| Single, multi-day, online or hybrid | As planned. One ticket covers every day; day passes come later. |
| **Paid series, per occurrence** | `TicketType` has `eventId` or `eventSeriesId`, never both (checked in the database), and `scope OCCURRENCE\|SERIES_PASS`. Add `EventInstance.capacity Int?`, falling back to the series capacity. `reserveRsvp` locks the instance `FOR UPDATE` and counts confirmed plus unexpired `PENDING_PAYMENT` RSVPs for that instance. Ticket-type capacity also applies per instance. |
| **Season or course pass** | A `SeriesPass` row (`orderId`, `seriesId`, `attendeeKey`, `coversFrom`, `coversUntil`). Taking a pass locks every covered future instance with `FOR UPDATE … ORDER BY id`, needs a seat in each, and creates one `PENDING_PAYMENT` RSVP per instance under a single hold. Instances added later inside the window seat pass holders first. `TicketType.capacity` limits how many passes are sold. Courses and cohorts use this. |
| Approval required | Pay after approval through a payment link, created lazily (fix 2). Cards are not held and captured later, because that does not work with UPI or links. |
| Invite only | Invitees skip approval but still pay. |
| Waitlist | Promotion leads to a lazy payment link with a 24-hour hold. |

### Every event setting in this app

| Event setting | Paid behaviour |
| --- | --- |
| Public (`PUBLIC`) | Anyone can buy, within sales windows and capacity. |
| Unlisted (`HIDDEN_LINK`) | Same as public for anyone with the link. The page and checkout are never listed or indexed. |
| Approval required (`APPROVAL_REQUIRED`) | Sign up first, pay after approval (lazy link, 24-hour hold). Rejected requests are never charged. |
| Invite only (`INVITE_ONLY`) | Only invitees can buy, and they still pay unless the organiser issues a complimentary ticket. Invite links stay private and are never logged. |
| Draft or hidden (`DRAFT`, `HIDDEN`) | No sales. Unpublishing stops new holds and leaves existing orders alone. |
| Cancelled (`CANCELLED`) | Cancelling with sales asks for confirmation, then starts the automatic full refunds in §4. |
| Online or in-person (`isOnline`) | Same checkout. |
| Multi-day | One ticket covers every day. |
| Registration cut-off (`registrationClosesAt`, `registrationLeadMinutes`) | Also ends sales. Holds already taken can still be paid until they expire. |
| **Embedded event widget** (`app/embed`) | Checkout opens in a new top-level tab (`target="_blank"`, `rel="noopener"`): the providers' pages must not run inside a frame. The widget then shows "Finish paying in the new tab", and the ticket page confirms. |
| **Conference sessions and tracks** (`EventSession`) | Sessions stay free inside a paid event by default. A session that needs its own seat or fee (a hands-on workshop) is sold as an add-on linked to `EventSession`, with its own capacity. |
| Series and occurrences | §2: per-occurrence tickets and series passes. |
| Organiser "Add guest" | Paid types offer three choices: complimentary, mark paid offline, or send a payment link. |
| Check-in desk, door station, ID badges, certificates | Only `CONFIRMED` (paid or free) is admitted. A pending ticket shows "Payment pending" with "Collect payment". Badges and certificates are issued only to paid or complimentary attendees. |

**Which organisation receives the money:**

- **The host decides.** Every event and series belongs to one host organisation. Every payment for it goes to that organisation's own connected Razorpay or Stripe account, and refunds come out of the same account.
- **Collaborators never change this.** Co-organisers are people, sometimes from another organisation, with permissions on one event. None of their permissions can connect keys, choose an account or redirect payment. The host's owner manages payment settings.
- **Paid events need a connected host account.** A paid ticket type can be published only when the host organisation's account is connected and `paidEventsEnabled` is on. Free ticket types and free events work exactly as before.
- **Buyers see who they pay.** The event's ticket settings show "Payments go to <host organisation> (Razorpay/Stripe, test or live)". Checkout and receipts name the host organisation as the seller.
- **Paying a partner instead.** To have a partner organisation receive the money, create the event under that organisation and add the other team as collaborators. Splitting revenue between organisations is out of scope; it would need Razorpay Route or Stripe Connect.

**Every audience, free or paid:** public, unlisted, approval-required and invite-only events each work with free tickets, paid tickets or a mix, on single events and series, as the table above sets out.

**Who can do what with payments:**
- **Organisation owners:** payment settings, as already planned.
- **Organisation admins, and collaborators with `MANAGE_REGISTRATIONS`:** refunds, waivers, offline payments, ticket changes and payment links.
- **Collaborators with `EDIT_DETAILS`:** ticket types, prices, add-ons and promo codes.
- **`CHECK_IN` volunteers:** only collect payment at the desk (recorded as offline).

Every action is audited.

## 3. Pricing

| Need | Design |
| --- | --- |
| Free and paid mixed, several types | As planned. |
| **Early bird and tiers** | `TicketType.tierGroup` and `tierOrder`. The next type in a group opens when the previous one's window ends or it sells out. The public page shows the next tier's price as the regular price. |
| **Pay what you want and donations** | `TicketType.pricingMode FIXED\|PAY_WHAT_YOU_WANT`, with `minPriceMinor`, `suggestedPriceMinor` and `maxPriceMinor`. A minimum of 0 allows free. Any non-zero amount must meet the provider minimum. The server validates the amount and freezes it in `OrderLine`; 0 skips checkout. An optional "Donation" add-on handles scholarship top-ups. No 80G receipts. |
| **Add-ons** (kit, lunch, T-shirt, materials fee) | `EventAddOn`: price, capacity, variants (for example sizes), `maxPerOrder` and `requiresTicket`. Stock is checked under the same lock and sold as `OrderLine` kind `ADD_ON`. |
| **Group or team tickets** | `TicketType.seatsPerTicket`. One line creates N RSVPs, and capacity counts seats. |
| **Member pricing** | `TicketType.eligibility ANYONE\|ID_PROGRAMME_MEMBER` with `idProgrammeId`. The server checks for an active, unexpired `IdMember` for the signed-in user. |
| **Hidden tickets** | `TicketType.visibility PUBLIC\|HIDDEN`. `PromoCode.kind DISCOUNT\|ACCESS` with `revealsTicketTypeIds`, stored as a digest like other codes. |
| Promo codes | As planned, plus `appliesPer TICKET\|ORDER`, `minQuantity` and `perOrderLimit`. A redemption counts when the hold is taken and is released if the hold expires, under the lock. Codes never apply to pay-what-you-want lines. |
| Buyer booking fee (optional) | Event-level `buyerFeeMinor` or `buyerFeeBps`, sold as a `FEE` line. Razorpay's account-wide convenience-fee setting is not used. |
| Complimentary tickets | A waiver, a 100% code, or a hidden ₹0 type. |

## 4. Money rules

- **Refund policy:** a structured `Event.refundPolicy` (`NONE`,
  `FULL_UNTIL <hours>` or `PERCENT_UNTIL <percent, hours>`, plus text). It
  is copied onto the order and shown before payment. After the first sale it
  can only become more generous.
- **Cancelling an event or occurrence** queues one idempotent full-refund
  outbox job per payment, emails attendees, and shows progress and failures
  to the organiser. Pass holders get a partial refund the organiser enters.
- **Disputes:** a `PaymentDispute` row (unique external id, status, amount,
  `respondBy`) from Razorpay `payment.dispute.*` and Stripe
  `charge.dispute.*` webhooks. The ticket is flagged and the organiser
  emailed; nothing is cancelled automatically.
- **Receipts, not tax invoices** (decided 2026-10-20): every paid order has a
  downloadable PDF receipt as proof of payment, from the order page and the
  "payment received" email (`GET /api/orders/:token/receipt`). It shows:
  - the organisation's registered name, registration number and address,
    set by the owner under Settings → Payments → Receipts;
  - the order number, buyer, event, lines, discount, total paid and refunds;
  - how it was paid, as Razorpay or Stripe report it (for example
    "Visa •••• 4242" or "UPI ••••@okicici", read once and kept on the
    payment), the provider's payment id, and a test-mode label.

  The platform computes no GST, VAT or other tax. Prices are what the buyer
  pays, and organisers handle any tax themselves.
- **Deposits and instalments** come later. Fix 3's order with several payments
  makes them additive: a `PaymentScheduleItem` with its own payments and
  attempts. Razorpay `accept_partial` and card mandates are not used.

## 5. Tickets after purchase

- **Transfers:** `Event.allowTransfers` with a cut-off. A transfer rotates
  `checkInToken`, re-keys `attendeeKey`, voids any issued badge or
  certificate, keeps the payment with the buyer, and is audited.
- **Ticket-type changes:** an organiser action. A higher price creates a
  payment for the difference; a lower one creates a partial refund. Type
  capacity is checked under the lock.
- **Collect at the door:** the check-in desk can mark a pending ticket paid
  offline (cash or UPI), with the method and reference.
- **Abandoned checkout:** one transactional reminder from our outbox about 6
  hours before a 24-hour hold ends.
- **Accessibility:** the hold countdown is announced through `aria-live`, a
  hold can be extended once, and attendee forms use the existing
  registration-field rules.

## 6. Razorpay and Stripe: every feature on both

Each organisation chooses its provider, and every feature above works on
both. The order, its lines, tax and promo codes are worked out by us, and
the provider only charges the order total. This keeps behaviour identical
and needs no tax or coupon features from either provider.

| Need | Razorpay (own account) | Stripe (own account) |
| --- | --- | --- |
| Hosted checkout | Payment Link (`POST /v1/payment_links`): the order total, `reference_id` = attempt id, `expire_by` ≥ 15 minutes, `notify` off, `callback_url` with `callback_method=get` | Checkout Session: one `price_data` line per order line (names shown to the buyer), `client_reference_id` = attempt id, `expires_at` between 30 minutes and 24 hours |
| Payment methods | UPI, cards, netbanking, wallets (INR) | Cards; local methods where the account has them (UPI is not on Stripe India) |
| Currencies | INR by default; others only if the account has international currencies enabled | Any currency the account supports; zero- and three-decimal currencies through ISO exponents |
| Paid | `payment_link.paid` / `order.paid` / `payment.captured` (never `authorized`) | `checkout.session.completed` with `payment_status=paid`, or `checkout.session.async_payment_succeeded` |
| Failed or expired | Link cancelled when the hold ends (`POST /payment_links/:id/cancel`) | Session expired (`POST /checkout/sessions/:id/expire`); handle `checkout.session.expired` |
| Pay what you want | We validate the amount and send it as the total | `price_data.unit_amount` set to the chosen amount |
| Add-ons, fees, group tickets | Folded into the total; the description lists them | Separate line items |
| Promo codes and tiers | Applied by us before the total | Applied by us; Stripe coupons are not used |
| Receipts | Our PDF receipt with the payment method from `GET /v1/payments/:id`; Razorpay's GST features are not used | Our PDF receipt with the method from the PaymentIntent's latest charge; Stripe Tax is not used |
| Refunds, full and partial | `POST /v1/payments/:id/refund` with `amount`; `refund.processed` / `refund.failed` | `POST /v1/refunds` with `payment_intent` and `amount`; `refund.updated` / `charge.refunded` |
| Disputes | `payment.dispute.created/won/lost/closed` (`respond_by`) | `charge.dispute.created/updated/closed` (`evidence_details.due_by`) |
| Minimum amount | ₹1 (100 paise) | Currency minimum (₹0.50) |
| Signature | HMAC-SHA256 of the raw body in `X-Razorpay-Signature`, with the webhook secret | `Stripe-Signature` `t=…,v1=…`, HMAC-SHA256 of `t.body`, 5-minute tolerance |
| Idempotency | `x-razorpay-event-id` | `event.id`; outgoing calls send `Idempotency-Key` = attempt or refund id |
| Test mode | `rzp_test_` keys | `sk_test_` / `rk_test_` keys |

Each feature's tests run against both providers' fake servers (the existing
opt-in fake provider), so no feature ships working on only one of them.

## 7. Delivery

`feat/payments-core` ([PR #16](https://github.com/SpaceWorks-Labs/SpaceWorks-Events/pull/16))
is not merged yet. Fold in `Order`, `OrderLine`, `PaymentCheckoutAttempt` and
the per-event currency there. Rework PRs 2 and 3 onto orders, then add:

1. **`feat/paid-series`:** occurrence tickets, series passes, instance capacity,
   and cancelling an occurrence with refunds.
2. **`feat/payment-receipts`:** the organisation's registered details and PDF
   receipts with the provider's payment details (no tax handling).
3. **`feat/ticketing-extras`:** tiers, pay what you want and donations,
   add-ons, group tickets, member pricing, hidden tickets and access codes,
   transfers, ticket-type changes, disputes, the booking fee, collecting
   payment at the desk, and abandoned-checkout reminders.
4. **`feat/payment-reporting`:** as planned, with orders, add-ons and
   series in exports and reports. The version goes to 0.10.0.

## Sources

- **Eventbrite:** ticket types and access codes (help 644100), add-ons, tiers,
  attendee details (246376), recurring events (692566), cancellation refunds
  (895183).
- **Luma:** paid events with approval, suggested price and coupons
  (help.luma.com).
- **Ti.to:** reassigning tickets, ticket changes, discount codes, donation tickets.
- **KonfHub:** tax and charges, GST invoices.
- **GST:** CGST Rule 46 (cbic.gov.in), 18% on admission, registration
  thresholds (cleartax.in).
- **Razorpay:** Payment Links API (`reference_id` unique, `expire_by` between
  15 minutes and 6 months, minimum 100 paise), disputes webhooks,
  convenience fees, RBI card-mandate rules.
- **Stripe:** Checkout `expires_at` between 30 minutes and 24 hours, INR
  minimum ₹0.50, India availability.
