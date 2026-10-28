# Plan: paid events (draft for approval)

> **Current status (2026-10-28):** paid events are built. This plan is kept as
> the record of what was decided before the work; [Payments](../PAYMENTS.md)
> describes how paid events work now and wins wherever the two differ.

Status: **draft, not approved**. Nothing below is built yet.

Decisions already made by the owner (2026-10-20):

- **Providers:** Razorpay **and** Stripe, behind one provider interface.
- **Accounts:** each organisation connects **its own** account. Money goes straight to the organiser; the platform never holds anyone else's money and takes no fee.
- **Scope:** full SpaceWorks parity:
  - ticket types;
  - seat holds and hosted checkout;
  - webhook settlement;
  - refunds, both full and partial;
  - offline payments, waivers and an amendment trail;
  - promo codes;
  - payments in exports and reports.

Design source: SpaceWorks' Django payments module (`backend/apps/payments`, `payments_rail`, `events/service_payments.py`), ported to this stack. Money conventions come from SpaceWorks-Workspace.

## 1. What changes for people

| Who | Today | After |
| --- | --- | --- |
| Attendee | Registers free | Picks a ticket type. **Free** types work exactly as today. **Paid** types redirect to the organiser's Razorpay or Stripe hosted page; the ticket is confirmed when the provider says it's paid. |
| Organiser | Capacity, approval, waitlist | Adds ticket types (price, capacity, sales window), promo codes, and a refund policy. Sees payment status per guest. Refunds (full or partial), marks offline payments, waives charges. Revenue appears in reports and exports. |
| Org owner | n/a | **Settings → Payments:** chooses Razorpay or Stripe, pastes keys (write-only, encrypted), copies the webhook URL, and runs **Test connection**. Test keys show a "Test mode" badge everywhere. |
| Super admin | n/a | **Settings:** "Allow paid events on this installation" (off by default). |

The platform never sees card or UPI details: checkout is always the provider's hosted page (Razorpay Payment Links, Stripe Checkout). So there is no embedded widget, and the CSP and `Permissions-Policy: payment=()` stay as they are.

## 2. Data model (one Prisma migration)

All money is **integer minor units in `BigInt`** (paise for INR), with an **uppercase ISO 4217 code**. Floats are never used. Minor-unit digits come from ISO exponents (0, 2 or 3), so zero-decimal currencies work.

- **`OrganisationPaymentSettings`** (1:1 with Organisation):
  - Provider choice and default `currency` (default `INR`).
  - Razorpay: `razorpayKeyId` (public), plus `razorpayKeySecretEncrypted` and `razorpayWebhookSecretEncrypted`.
  - Stripe: `stripeSecretKeyEncrypted` and `stripeWebhookSecretEncrypted`.
  - `webhookPathId`: random, so URLs never reveal the slug.
  - `updatedAt`.
  - Secrets use AES-256-GCM like the SMTP settings, with their own HKDF info string. An organisation counts as "configured" only when the selected provider has **all** of its credentials.
- **`TicketType`** (per event): `name`, `description`, `priceMinor` (0 = free), `currency`, `capacity?`, `salesStartAt?`, `salesEndAt?`, `sortOrder`, `archivedAt?`. The event's existing `capacity` stays the overall cap.
- **`RSVP`** gains:
  - `ticketTypeId?`
  - a frozen `quotedAmountMinor` and `currency`
  - `holdExpiresAt?`
  - the new `RsvpStatus.PENDING_PAYMENT`
- **`Payment`** (one per paid RSVP; a ledger row that survives RSVP deletion):
  - Ownership: `organisationId`, `eventId`, `rsvpId?` (`SetNull`).
  - Amounts: `amountMinor`, `discountMinor`, `currency`.
  - `status`: `PENDING | PAID_ONLINE | PAID_OFFLINE | WAIVED | CANCELED | EXPIRED`.
  - `provider`: `RAZORPAY | STRIPE | OFFLINE`.
  - Provider ids: `externalCheckoutId`, `externalPaymentId`, each unique per provider. `checkoutUrl`, `testMode`.
  - `paidAt`; offline method and reference; `promoCodeId?`.
  - A database check requires `amountMinor > 0`. Postgres triggers keep terminal rows and provider ids immutable.
- **`PaymentRefund`**: `amountMinor`, `status PENDING|SUCCEEDED|FAILED`, `externalRefundId`, `offline`, `reason`, `createdByUserId`. Invariant: pending plus succeeded refunds never exceed the payment, enforced under a row lock and by a trigger.
- **`PaymentAmendment`**: an append-only record of corrections to offline payments (old and new values, reason, actor).
- **`PromoCode`** (per event):
  - Only a **SHA-256 digest** of the normalised code is stored, plus a short display hint.
  - Discount is `PERCENT | FIXED`, with an optional ticket-type restriction, `maxRedemptions`, a redeemed count and a validity window.
  - A 100 % discount makes the ticket free, with no checkout.
- **`ProcessedWebhookEvent`**: unique on `(organisationId, provider, eventId)`, for idempotency.
- **`InstanceSetting.paidEventsEnabled`** (`Boolean @default(false)`).

## 3. Flows

**Buying a ticket**:
1. `reserveRsvp` gains ticket-type checks: sales window, type capacity and event capacity, still under the existing `FOR UPDATE` lock.
   - **Confirmed and unexpired `PENDING_PAYMENT` RSVPs both count** toward capacity.
   - A paid ticket creates the RSVP as `PENDING_PAYMENT` with a **30-minute hold**, plus a `Payment(PENDING)`.
2. After commit, the provider checkout is created:
   - Razorpay: `POST /v1/payment_links`, with `reference_id` = payment id, `expire_by` = the hold, and Razorpay's own notifications off.
   - Stripe: `POST /v1/checkout/sessions`, with `expires_at` = the hold and `client_reference_id`.
3. The attendee is redirected. A gateway failure leaves a retryable pending ticket, never a lost seat. The ticket page offers **Pay now** until the hold ends.
4. **Webhook settlement** turns the payment into `PAID_ONLINE` and the RSVP into `CONFIRMED`, then queues the receipt and ticket email through the outbox.
   - Payment matching uses provider-echoed ids only, under a row lock.
5. The return page (`/ticket/:token?payment=return`) shows "Confirming payment…". It may make one server-side status fetch with the organisation's secret, to settle before the webhook arrives.

**Holds expire** in the existing outbox/scheduler tick (`/api/internal/outbox` every minute; no new service):
- The provider checkout is **cancelled first** (Razorpay cancels the payment link, Stripe expires the session).
- The seat is released only after that succeeds. If the provider says the payment already succeeded, it is settled instead.
- A payment that still arrives after release is confirmed if a seat is free. Otherwise it is **automatically refunded in full**, and the attendee and organiser are emailed.

**Approval-required and waitlist events:**
- Approval, or promotion from the waitlist, moves the RSVP to `PENDING_PAYMENT` with an emailed payment link and a **24-hour hold**.
- When that hold expires, the next person on the waitlist is offered the seat.

**Webhooks** go to the backend's API host:
- `POST /api/webhooks/razorpay/:webhookPathId` and `POST /api/webhooks/stripe/:webhookPathId`.
- **Signature checks**, on the raw body (`await request.text()`, size-capped) before any parsing:
  - Razorpay: HMAC-SHA256 against `X-Razorpay-Signature`.
  - Stripe: `t=…,v1=…` HMAC over `t.body`, with 5 minutes of tolerance.
  - Both are compared in constant time with the organisation's own secret. The path id only *addresses* the organisation.
- **Events that count:**
  - Paid: Razorpay `payment_link.paid`, `order.paid` and `payment.captured`, but **not** `payment.authorized`. Stripe `checkout.session.completed` with `payment_status=paid`, and `checkout.session.async_payment_succeeded`.
  - Refunds: Razorpay `refund.processed` and `refund.failed`; Stripe `refund.updated` and `charge.refunded`.
- **Responses:** verified events that are ignored get a 200. Bad signatures get a 400 with no detail.
- **Idempotency:** `ProcessedWebhookEvent` records each event. Razorpay's id comes from `x-razorpay-event-id`, Stripe's from `event.id`.
- **Proxying:** the split-mode frontend proxy never forwards webhooks; provider dashboards point straight at the API host. Webhook routes get their own rate-limit bucket.

**Refunds** (organiser, `EVENT_MANAGE` or above):
1. Under a row lock, check the remaining refundable balance and write a `PENDING` refund.
2. Call the provider **outside** the lock: Razorpay `POST /v1/payments/:id/refund`, or Stripe `POST /v1/refunds`.
3. Settle from the response. The refund webhooks finish any that are still pending.

Rules around refunds:
- A full refund also cancels the ticket and frees the seat; partial refunds don't.
- **Attendee self-cancel** of a paid ticket is allowed only if the event's refund policy says "automatic full refund until N hours before start". Otherwise the cancel button explains that the organiser handles refunds.
- **Offline refunds** are recorded without calling a provider.

**Offline payments and waivers:** the organiser can do the following on a pending payment:
- Mark it **paid offline**: cash, UPI, bank transfer, card terminal or other, with a reference.
- **Waive** it (complimentary ticket).
- Send a fresh **payment link**.

"Add guest" can also issue a paid ticket in each of those three ways. Corrections to offline records go into `PaymentAmendment`, never edits in place.

**Check-in** still admits only `CONFIRMED`, so a `PENDING_PAYMENT` ticket shows "Payment pending" at the desk.

**Series events:** ticket types apply to single events in this release. Series stay free, and the editor explains why. Paid series occurrences are a follow-up, because capacity there is per occurrence.

## 4. Security and privacy

- **Settings:**
  - Payment settings are viewed and changed by the org **OWNER** only, with MFA step-up.
  - Secrets are write-only: the view returns only "is set" booleans, and the new column names are added to the gateway's secret-field deny-list.
  - Each change is audited, with boolean metadata only.
- **Audit:** every payment state change, refund, waiver, offline mark and amendment is audited without amounts tied to people in metadata, and never with tokens.
- **Stored data:** only provider ids, amounts, status and the offline reference. **Never** card, UPI or bank details, or raw webhook payloads.
- **Organisation isolation:**
  - Every payment query is scoped by `organisationId`.
  - Webhooks resolve the organisation from `webhookPathId` and verify with that organisation's secret.
  - Cross-organisation ids can never match, because provider ids are unique per provider and the lookup is also scoped to the organisation.
- **Test mode:** `rzp_test_` and `sk_test_` keys mark payments `testMode`. Test payments are excluded from revenue totals and labelled in the user interface and emails.
- **Personal data export:** includes the person's own payments and refunds (amount, status, dates, provider payment id).
- **Machine API:**
  - `participants:read` gains `ticketType` and `paymentStatus`.
  - Amounts need a new `payments:read` scope.
  - DTOs stay minimal.

## 5. Reporting, exports and copy

- **Attendee CSV:** adds ticket type, amount paid, refunded and payment status.
- **Event report and PDF:** gross, refunds and net revenue **per currency**; tickets by type; promo redemptions.
- **Product copy and legal text:** every "always free / no payments" statement is rewritten, including `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `docs/DESIGN.md`, `docs/FEATURES.md`, the user manual, the landing and about pages, the footer, and `RegistrationCard`.
  - **Terms:** organisers are the merchant of record and responsible for their prices, refunds and taxes.
  - **Privacy:** payment processors receive payment data, and the platform never sees card or UPI details.
  - **The rewritten terms and privacy text need your review before release.**
- **Prices:** shown tax-inclusive. GST invoices are out of scope (see §7).

## 6. Delivery: four pull requests into `dev`

Each PR has its own branch from `dev`, passes lint, `tsc`, unit, integration and e2e checks, and keeps the app releasable:

1. **`feat/payments-core`**:
   - Schema and migration, with money helpers and tests.
   - Org payment settings: page, encryption, Test connection.
   - The super-admin switch.
   - The Razorpay and Stripe clients (plain `fetch`, no SDKs).
   - Webhook routes with signature and idempotency tests.
2. **`feat/paid-tickets`**:
   - Ticket types in the event editor; ticket choice on the public page and in the frontend workspace (catalog regenerated).
   - Holds and capacity: concurrency integration tests.
   - Checkout, the return page, settlement, hold expiry and late-payment handling.
   - Emails; ticket page states; check-in gate.
3. **`feat/payment-operations`**: refunds (organiser and self-cancel policy), offline payments, waivers, amendments, promo codes, approval and waitlist payment links.
4. **`feat/payment-reporting`**: exports, reports, the API scope, the personal data export, all copy, legal and docs (`docs/PAYMENTS.md`, user manual), and the version bump to **0.10.0**.

**Testing without real money:**
- Provider calls go through one small HTTP client whose base URL can point at a local **fake provider** in tests only. The override is refused when `NODE_ENV=production`.
- Playwright drives the full buy → webhook → confirmed → refund flow against that fake provider.
- If you share Razorpay and Stripe **test** keys, I'll also run one live test-mode purchase and refund on a local install.

## 7. Not in this release (follow-ups)

- Paid **series** occurrences.
- GST or tax invoices and tax-rate fields.
- Platform fees or marketplace payouts (Razorpay Route / Stripe Connect). Per-organisation accounts make these unnecessary.
- Multiple currencies inside one event.
- Instalments or donations ("pay what you want").

## 8. Risks and assumptions

- **Policy reversal:** the project (and upstream Yuyu) has promised "free events only". This plan deliberately reverses that, including the public terms.
- **Upstream licence:** Yuyu, the upstream project, has **no licence file**. This repository relicenses derived code as AGPL. That is unrelated to payments but worth settling with Yuyu's author before more public releases.
- **Stripe in India** is invite-only for new Indian businesses, so Razorpay is the realistic default there. The settings page says so.
- **Holds:** a 30-minute hold can briefly show an event as full while people are paying. The public page shows "N seats being held".
- **Migration:** adds columns and tables only; existing RSVPs stay free and confirmed. A rollback is safe while no paid tickets exist.
