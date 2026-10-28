# Mobile API v1

[Documentation index](README.md)

`/api/mobile/v1` is the user-authenticated REST API used by the Space Works
mobile apps (Android and iOS). It covers phone-first tasks: signing in, an
attendee's own registrations, tickets, paid orders, expense claims, projects,
entry fees, prizes and team, organiser day-of work (check-in and check-in
lists, settling payments at the desk, guest and team approval, emails, live
programme delays, feedback open/close, closing sign-ups, expense claims and
refund requests), and hackathon judging. It was ported from Yuyu and adapted
to Space Works' paid events, finance, staff authenticator and sign-in
protections.

The app calls the API host directly (the backend container in a split
installation, [DEPLOYMENT_SPLIT.md](DEPLOYMENT_SPLIT.md)); the website host's
`/api` proxy is not opened to it. Checkout pages open in the system browser
(Android Custom Tabs, iOS `ASWebAuthenticationSession`); the app then polls the
order until the provider's webhook confirms it.

The machine-readable contract is [`mobile-api.openapi.yaml`](mobile-api.openapi.yaml)
(OpenAPI 3.1), with example responses in [`mobile-api-fixtures/`](mobile-api-fixtures/).
`tests/unit/mobile-api-contract.test.ts` fails if the spec, the fixtures, the
server's strict response schemas (`lib/mobile/schemas/`) or the implemented
routes drift apart, and `tests/unit/mobile-secret-fields.test.ts` fails if any
response DTO could carry a secret (an order's access token, team or
submission links, or a ticket token outside the caller's own confirmed
ticket).

It is **not** the machine API (`/api/v1`). Machine clients are tenant-bound
bearer identities; mobile sessions are individual users whose permissions
are resolved exactly as on the website. A signed-in mobile request runs as an
explicit request actor (`lib/requestActor.ts`): `auth()` presents the app
session, so every mobile mutation runs the matching Server Action's own body
(`lib/core/*` names the entry points), and organisation isolation, role and
event-permission checks, the staff authenticator, capacity and payment-hold
transactions, refunds, waitlist fills, rate limits, webhooks, chat notices,
emails and audit behaviour are identical.

### Staff authenticator

Organisation staff (any membership, or an event or series co-organiser grant)
must pass an authenticator check, as on the website. An app session carries
its own proof, `mfaVerifiedAt`, set by a sign-in that included `totp` or by
`POST /auth/mfa`, and valid for 12 hours. Every `/orgs/...` route answers
`STAFF_MFA_REQUIRED` (403) until then, or `STAFF_MFA_ENROLMENT_REQUIRED` (403)
while the account has no authenticator (set one up on the website, which signs
the app out). `GET /me` reports the state as `staffMfa`. Attendees and the
super admin are exempt. The permission helpers underneath fail closed too.

## Conventions

- Request bodies are read with a hard cap whether or not `Content-Length` is
  sent (256 KB for JSON, 16 MB for receipt uploads); past it the answer is 413
  `PAYLOAD_TOO_LARGE`.
- A request without a bearer runs as an explicit anonymous actor: it is
  signed out, whatever cookies it carries, so a browser cookie never acts
  through the mobile API.
- Rate limits: signed-in calls are limited per user (300 a minute) rather than
  per address, because phones at one venue often share a NAT address; sign-in
  (10 a minute), refresh (60 a minute) and the proxy's global ceiling are per
  address, so a crowded venue Wi-Fi can meet the sign-in limit. Ask people to
  sign in before the event.

- JSON in and out. Every response carries `Cache-Control: no-store`.
- Authenticated routes need `Authorization: Bearer <accessToken>`.
- Success: `{ "ok": true, "data": ... }`. Failure:
  `{ "ok": false, "error": { "code": "...", "message": "UI-safe text", "fieldErrors"?: { "field": ["msg"] } } }`.
- Codes: `INVALID_REQUEST` (400), `UNAUTHENTICATED` (401: missing, expired,
  revoked or version-stale access token — refresh once, then sign out),
  `MFA_REQUIRED` (401, sign-in only), `EMAIL_VERIFICATION_REQUIRED` (403,
  sign-in only), `FORBIDDEN` (403), `NOT_FOUND` (404; also every id outside
  what the caller can see, including other organisations'), `CONFLICT` (409),
  `NEEDS_FORCE` (409, check-in status override available), `RATE_LIMITED`
  (429, with `Retry-After`), `TEAM_REQUIRED` (409, `POST /rsvp` on an event
  that registers teams only), `INTERNAL_ERROR` (500).
- Space Works codes: `STAFF_MFA_REQUIRED` and `STAFF_MFA_ENROLMENT_REQUIRED`
  (403, organiser routes; see below), `EMAIL_CODE_REQUIRED` (401, sign-in
  only), `TOO_MANY_ATTEMPTS` (429, sign-in blocked for the address or account),
  `REAUTH_REQUIRED` (401, sign in again before signing out everywhere),
  `PAID_ORDER` (409, money was taken: use the order's refund rules),
  `REGISTRATION_CLOSED` (409) and `PAYMENT_UNAVAILABLE` (503, the payment
  provider can't be reached).
- Team and judging refusals carry their own codes so the app can react
  without parsing messages:
  - `TEAM_MEMBER` (409): an individual approve, reject, promote or re-accept
    on a guest who belongs to a team. Change the whole team instead
    (`…/teams/:teamId/approve|reject|promote`).
  - `TEAM_INCOMPLETE` (409): approving a team below the event's minimum team
    size.
  - `CAPACITY_FULL` (409): approving or promoting a team with no free unit.
  - `JUDGING_CLOSED` (409): judging is not `OPEN`, so scores and reviews are
    frozen.
  - `INCOMPLETE_SCORES` (409): submitting a review before every criterion is
    scored (or while the event has no rubric).
  - `NOT_VISIBLE` (404): a project this judge may not score (not submitted,
    unassigned, conflict of interest, or another event's). Treat it like
    `NOT_FOUND`.

  Older apps see these as unknown codes with the usual HTTP status and a
  UI-safe message.
- Error messages are the same UI-safe texts as the website (for example
  "Only pending requests can be approved."); show them as-is.
- Timestamps are ISO-8601 UTC strings. Event times come with the IANA `timezone`.
- Image and link URLs are absolute (resolved against `NEXT_PUBLIC_BASE_URL`, or
  the request origin when unset). Uploaded images are served by
  `/api/uploads/...` as public, re-encoded derivatives; no token is needed.
- Collections with `nextCursor` use opaque cursors: send it back unchanged;
  `null` means the end.
- Never log or persist access tokens, refresh tokens, ticket tokens or station
  PINs. Ticket tokens are returned only to their owner, and to holders of the
  event `CHECK_IN` permission through the offline roster.
- Limits: the proxy's per-IP API limit, 300 authenticated requests per minute
  per user, plus each operation's own website limit (check-in, RSVP,
  broadcasts, sign-in…).

## Sessions

Mobile sessions are rows in `MobileSession`; only SHA-256 digests of tokens are
stored. Access tokens (`swa_…`) live 15 minutes, refresh tokens (`swr_…`) 60
days and rotate on every refresh. A refresh must send the same install id
(`deviceId`, stored as a SHA-256) as the sign-in; presented with any other, it
revokes the session. The id is client-supplied: it stops a refresh token
replayed without it, not someone who copied both from the phone, so keep both
in the platform keystore. If a refresh succeeded but its response was
lost, retrying with the previous refresh token within 30 seconds of the
rotation gets a plain `UNAUTHENTICATED` without revoking anything (the app
should then use the newest tokens it holds, or sign in again). The last three
rotated-away refresh tokens are remembered: presenting any of them (the newest
after that window, the older ones at any time) revokes the whole session (it
was copied). Each session is
bound to the user's `sessionVersion`: a password change, password reset, MFA
enable/disable, "sign out everywhere" or operator recovery bumps it and
invalidates every mobile session together with web sessions (the rows are also
marked revoked).
Sign-in, sign-out, authenticator checks and refresh-token reuse are audited
(`MOBILE_SIGNED_IN`, `MOBILE_SIGNED_OUT`, `MOBILE_MFA_VERIFIED`,
`MOBILE_REFRESH_TOKEN_REUSED`)
without token values. Expired and long-revoked rows are removed by the
retention job.

`deviceId` is required on sign-in and refresh: the install's own random id,
32 to 64 lowercase hex characters, kept for the life of the install. `deviceName`
is free text and `platform` (`"android"` or `"ios"`) is optional; both are
stored only for support and audit. The app should send a user agent starting
`SpaceWorksEvents/<version> (Android …)` or `(iOS …)`, which the new sign-in
alert names as "the Space Works app".

### `POST /auth/login`

```json
{ "email": "a@b.c", "password": "…", "totp": "123456", "emailCode": "123456", "deviceId": "9f…", "deviceName": "Pixel 9", "platform": "android" }
```

`totp` is optional and accepts an authenticator code or a recovery code. Uses
the same verifier as web sign-in (`lib/credentialsAuth.ts`): per-address and
per-account failure limits, equal-work bcrypt comparison, inbox verification,
the emailed code for a new device and the authenticator. Errors:
`UNAUTHENTICATED` with "Email or password is incorrect." for any bad
credential or malformed body; only after a correct password, `MFA_REQUIRED`
(send `totp`) or `EMAIL_CODE_REQUIRED` (a new install or recent failures: a
six-digit code was emailed; send it as `emailCode`);
`EMAIL_VERIFICATION_REQUIRED` for an unverified password account;
`TOO_MANY_ATTEMPTS` (429) when the address or account is blocked;
`RATE_LIMITED`. A sign-in from an install the account hasn't used before sends
the "new sign-in" alert, as on the web.

Success → `Session`:

```json
{
  "accessToken": "swa_…", "accessTokenExpiresAt": "…",
  "refreshToken": "swr_…", "refreshTokenExpiresAt": "…",
  "user": { "id": "…", "name": "…|null", "email": "…|null", "imageUrl": "…|null", "emailVerified": true, "mfaEnabled": false }
}
```

### `POST /auth/google`

`{ "idToken": "…", "deviceId": "…", "deviceName": "…", "platform": "ios" }`. The server verifies
the Google ID token's signature against Google's JWKS, the issuer
(`accounts.google.com`), expiry, and that `aud` is the instance's web Google
client id or one of the app client ids (Super admin → Settings → Google SSO →
Mobile app client IDs, else `GOOGLE_MOBILE_CLIENT_IDS`). Mobile Google sign-in
is off (`FORBIDDEN`, and `googleSignIn.enabled: false` in `/auth/config`) until
app client ids are configured. When `aud` is the web client id (the usual
"server client id" flow), the token's `azp` must be one of them. There is no
server nonce yet: the token's short life and the `azp` check bound replay;
apps should request a fresh token per sign-in. Staff then confirm an
authenticator code with `POST /auth/mfa`, as on `/verify-mfa`. Requires `email_verified: true`. Applies the same linking and
account-creation policy as web Google sign-in (`lib/googleSignIn.ts`); new
Google links keep identity fields only. Success → `Session`.
`FORBIDDEN` when Google sign-in is not configured on the instance, account
creation is disabled, or linking is refused (an unverified password account
with that email). `UNAUTHENTICATED` when the token fails verification.

### `POST /auth/refresh`

`{ "refreshToken": "swr_…", "deviceId": "…" }` → `Session` with new access
**and** refresh tokens. `UNAUTHENTICATED` for unknown, expired, revoked, reused or
version-stale tokens (indistinguishable). Rate limited per IP.

### `POST /auth/logout` (auth)

Revokes the current mobile session → `null`.

### `POST /auth/logout-all` (auth)

Same body as "Sign out everywhere" on the web: bumps `sessionVersion`,
revoking all web and mobile sessions, and is audited as `SESSIONS_REVOKED`.
Like the web it needs a sign-in within the last 10 minutes: otherwise
`REAUTH_REQUIRED` (401); sign in again and retry.

### `POST /auth/mfa` (auth)

`{ "code": "123456" }` (authenticator or recovery code) → `{ "mfaVerifiedAt" }`.
Records the check on this app session for 12 hours of staff access
(`MOBILE_MFA_VERIFIED`). `STAFF_MFA_ENROLMENT_REQUIRED` when the account has no
authenticator; `INVALID_REQUEST` for a wrong code. Shares the web's `auth`
limit (per address and per account) and has its own per-address limit. A
recovery code is accepted, as on the website, and works once; failures and
recovery-code use are audited (`MOBILE_MFA_FAILED`,
`MOBILE_MFA_RECOVERY_CODE_USED`), never with the code.

### `GET /auth/config` (public)

`{ "instanceName": "Space Works Events", "googleSignIn": { "enabled": true, "webClientId": "…|null" }, "signupEnabled": true, "paidEventsEnabled": true, "baseUrl": "https://…" }`.
Google sign-in is enabled when web Google SSO is configured; use `webClientId`
as the server client id when requesting an ID token. Never includes secrets.
Account creation and password reset happen on the website.

## Me

### `GET /me` (auth)

`{ "user": User, "organisations": [OrgSummary], "collaborations": [{ "organisation": { "slug", "name" }, "eventId", "eventTitle", "permissions": ["CHECK_IN", …] }], "judging": [JudgingEvent] }`

`OrgSummary = { "id", "slug", "name", "logoUrl|null", "role": "OWNER|ADMIN|MEMBER" }`.
Collaborations list standalone-event grants only; `JUDGE` is never listed in
`permissions`, and a `JUDGE`-only grant is not a collaboration.

`JudgingEvent = { "organisation": { "slug", "name" }, "eventId", "eventTitle", "startDateTime", "endDateTime", "timezone", "judgingStatus": "NOT_STARTED|OPEN|CLOSED" }`:
events the caller judges through a `JUDGE` grant, once the event takes
submissions. Organisation owners and admins judge through their role: they
find their events through `myPermissions.judge` on the organiser event list.

### `PATCH /me` (auth)

`{ "name": "…" }` → `User`. Same validation, rate limit and audit as the web
profile form; the current profile image is kept.

### `GET /me/registrations` (auth)

Built from the same records as the account Registrations page
(`loadAccountRegistrationRecords`: own RSVPs only, the first page of each
section: 50 upcoming, 50 past and 50 certificates). The web page pages further
with `?upcoming=`, `?past=` and `?certificates=`; this endpoint does not.

```json
{
  "upcoming": [Registration], "past": [Registration],
  "certificates": [{ "eventTitle", "organisationName", "issuedAt", "certificateUrl" }]
}
```

`Registration = { "rsvpId", "status", "checkedInAt|null", "registeredAt", "canCancel", "ticketToken|null" (only for CONFIRMED), "event": EventSummary, "instanceId|null", "team"?: MyTeam }`.
For a recurring-series occurrence `instanceId` is set and `event` describes the
series (its `id`/`slug`, the occurrence's times, no cover image).

`team` is present only for a registration in a team:
`MyTeam = { "id", "name", "role": "LEADER|MEMBER" (the caller's), "size", "maxSize|null", "members": [{ "displayName", "isLeader" }] }`.
Members are shown as first name and last initial ("Ada L."), as on the
seeker list; never emails, answers, tickets, or the join and management links
(team management stays on the website).

### `GET /me/registrations/:rsvpId/team` (auth)

`{ "team": MyTeam|null }` for one of the caller's own registrations (`null`
for a solo registration). Anyone else's RSVP, including a teammate's, is
`NOT_FOUND`.

### `POST /me/registrations/:rsvpId/cancel` (auth)

Cancels the caller's own RSVP with the website's cancel rules (refused after
check-in, promotes the waitlist, queues emails, audited) → `null`.
`NOT_FOUND` for anyone else's RSVP.

## Public (no auth required; a valid bearer, if sent, identifies the attendee; an invalid one is 401)

`EventSummary = { "id", "slug", "title", "coverImageUrl|null", "startDateTime", "endDateTime", "timezone", "location", "mapLinkUrl|null", "isOnline", "accentColor|null", "status", "registrationMode": "INDIVIDUAL|TEAM", "organisation": { "slug", "name", "logoUrl|null" } }`

On `TEAM` events capacity counts registration units (each team, and each solo
registrant, is one): word it as "teams & solo places" ([Team registration](TEAMS.md)).
Recurring-series occurrences are always `INDIVIDUAL`.

### `GET /public/discover?cursor=&limit=`

Published, publicly listed standalone events (`listedEventAudienceWhere`) with
a released page that have not ended, soonest first. `limit` 1–50 (default 20).
→ `{ "events": [EventSummary], "nextCursor": "…|null" }`.

### `GET /public/search?q=`

The same predicate and 48-result cap as `GET /api/search` →
`{ "events": [EventSummary], "nextCursor": null }`. Both routes use the search
rate limit.

### `GET /public/short/:code`

Resolves an event short link with the same rule and per-IP limit as
`/:shortCode` → `{ "orgSlug", "eventSlug" }`. Unknown, unreleased and
rate-limited codes are the same `NOT_FOUND`. Publishing an event releases its
page in the same transaction, so a Live event's code resolves at once; clients
should not cache a `NOT_FOUND` for long, because events published before that
fix return it until the `20261021010000_realign_event_publication` migration
runs.

### `GET /public/events/:orgSlug/:eventSlug`

Applies the public event access rule (`resolvePublicEventAccess`): draft,
hidden and unreleased events are `NOT_FOUND`; invite-only events need a
signed-in user invited with their verified email. Only published website
content is returned.

```json
{
  "event": EventSummary & { "description", "tags", "capacity|null", "showRegistrationCount", "confirmedCount|null", "privacyType", "registrationOpen", "registrationFull", "registrationClosedReason|null", "onlineUrl": null },
  "registration": { "requiresApproval": false, "fields": [RegistrationField], "myRsvp": { "rsvpId", "status", "ticketToken|null" } | null },
  "schedule": [{ "trackName|null", "sessions": [{ "id", "title", "startDateTime", "endDateTime", "delayMinutes", "room": null, "speakers": ["name"] }] }],
  "speakers": [{ "name", "title|null", "photoUrl|null" }],
  "feedbackOpen": false
}
```

`confirmedCount` is null when the organiser hides counts. Schedule times
already include live delays; `delayMinutes` says how late that session is
running. `onlineUrl` and `room` are always null (neither is stored).

`RegistrationField = { "id", "key", "label", "type": "TEXT|TEXTAREA|EMAIL|PHONE|SELECT|MULTI_SELECT|RADIO|CHECKBOX|NUMBER|DATE", "required", "helpText|null", "placeholder|null", "options": ["…"], "settings": { "minLength?", "maxLength?", "min?", "max?", "minDate?", "maxDate?", "maxSelections?", "allowOther?" }, "showIf": { "fieldKey", "values": ["…"] } | null }`

This mirrors the stored field settings exactly: show the field when the earlier
field `fieldKey` is answered with any of `values` (CHECKBOX answers count as
"Yes"/"No"). The server remains the authority and drops answers hidden by logic.

### `POST /rsvp`

The same body, service (`submitRsvpCore`) and IP/email limits as
`POST /api/rsvp`: `{ "orgSlug", "eventSlug" | "eventInstanceId", "name", "guestEmail", "answers": { "<field key>": value } }`.
With a valid bearer the signed-in flow applies (`guestEmail` is ignored and
`name` is needed only if the account has none); otherwise the guest flow
(`name` and `guestEmail` required; invite-only events refuse guests).
Success: `{ "rsvpId", "status": "CONFIRMED|WAITLISTED|PENDING_APPROVAL", "ticketToken|null" }`,
with `ticketToken` only when `CONFIRMED`.

Team events ([Team registration](TEAMS.md)): send `team` as on the website
(create a team, join with a join link's token, or solo). Without it the
registration is solo, which works when the event allows solo registrants; an
event that registers teams only answers `TEAM_REQUIRED` (409).

## Paid tickets, orders and money (Space Works)

Paid tickets work as on the website ([Payments](PAYMENTS.md)): the organisation's
own Razorpay or Stripe account, holds while the buyer pays, promo and access
codes, passes, pay at the desk, and refunds under the policy frozen at purchase.

- `GET /public/events/:orgSlug/:eventSlug` adds `ticketing` (null for a free
  event): `{ "currency", "tickets": [PublicTicket], "addOns", "promoCodes", "accessCodes", "sellsPaid", "paidSalesOpen", "refundPolicy|null" }`.
  Members-only tickets appear for members (send the bearer).
- `GET /public/series/:orgSlug/i/:instanceId` → one series date with its
  tickets and passes, `paidRequest` (`approval` or `waitlist` when a paid
  request is what the form makes), the caller's own registration and the next
  dates (same access rule as the website).
- `POST /public/promo/check` `{ "orgSlug", "eventSlug" | "eventInstanceId", "code" }`
  → the code's rule to preview a discount (the order is priced again when placed).
- `POST /public/access-code/unlock` (same body) → `{ "tickets": [PublicTicket] }`
  the code reveals; send the same `accessCode` with `POST /rsvp`.
- `POST /rsvp` takes the website's ticket fields too: `items`
  (`[{ "ticketTypeId", "quantity", "amountMinor?" }]`) or `ticketTypeId`,
  `addOns`, `promoCode`, `accessCode`, `attendees`, `payAtDesk`, and `team`.
  Buying tickets needs a bearer (so the order lists under `/me/orders`). A paid
  registration answers `{ "rsvpId", "status": "PENDING_PAYMENT", "ticketToken": null, "orderId", "checkoutUrl", "holdExpiresAt" }`;
  open `checkoutUrl` in the system browser and poll `GET /me/orders/:orderId`.
  It is never `CONFIRMED` until the provider's webhook records the payment. A
  paid request (approval event or paid waitlist) answers `PENDING_APPROVAL`
  with its `orderId` and no checkout; the organiser's approval emails a link.
- `POST /me/registrations/:rsvpId/cancel` on a ticket with money collected
  answers `PAID_ORDER` (409); cancel the order instead. A paid request is
  withdrawn and a held order released, as on the website.

### Orders (auth; the caller's own, by id)

The order's access token is never sent to the app; the signed-in buyer reaches
their orders by id, and anyone else's are `NOT_FOUND`.

- `GET /me/orders?cursor=` → `{ "orders": [OrderSummary], "nextCursor" }`.
- `GET /me/orders/:orderId` → the order page as data: status, hold, money
  (formatted strings), refund policy and what cancelling returns, the refund
  request, lines and tickets (`ticketToken` only on a `CONFIRMED` ticket).
- `POST /me/orders/:orderId/checkout` → `{ "checkoutUrl" }` for a held order
  (`CONFLICT` once the hold ended, `PAYMENT_UNAVAILABLE` when the provider is
  unreachable).
- `POST /me/orders/:orderId/cancel` → the order, cancelled and refunded as its
  policy allows.
- `POST /me/orders/:orderId/refund-request` `{ "reason" }` → `201` (outside the
  policy; one open request at a time).
- `GET /me/orders/:orderId/receipt` → the receipt PDF once money was collected.
- `POST /me/orders/:orderId/transfer` `{ "rsvpId", "name", "email" }` and
  `PATCH /me/orders/:orderId/tickets/:rsvpId` `{ "name", "email?", "answers?" }`
  → the order, where the organiser allows transfers.
- `GET /me/registrations/:rsvpId/team` adds `order` (`{ "orderId", "status", "holdExpiresAt" }` or null) for a paid team place.

### Expense claims, projects and prizes (auth)

- `GET /me/registrations/:rsvpId/claims` → the registration's participant
  claims (travel grants), cap and categories, or `null` when the event takes
  none. `POST` the same path as `multipart/form-data` (`category`,
  `description`, `amount`, up to three `receipts` photos) to file one;
  `POST …/claims/:claimId/withdraw` before it is decided. Receipt photos of the
  caller's own claims: `GET /me/claims/:claimId/receipts/:receiptId`.
- `GET /me/submissions` → each hackathon project the caller is an entrant of,
  with its window and entry fee; `POST /me/submissions/:eventId/entry-fee/checkout`
  → `{ "checkoutUrl" }` for an unpaid fee (`CONFLICT` once paid). Editing a
  project stays on the website for now.
- `GET /me/prizes` → awards the caller's projects won (published results only)
  with payouts as amount and date. Payout references, notes and who recorded
  them stay with the organisers.


### `GET /public/events/:orgSlug/:eventSlug/feedback`

`{ "title", "intro": null, "thankYouMessage", "open": true, "certificatesEnabled", "fields": [RegistrationField] }`
or `NOT_FOUND` unless the event is published and its form is open (as the web
feedback page). Submit with the existing `POST /api/feedback`; its response
contains the certificate token when one is issued.

### Existing web endpoints reused unchanged

These keep their own response formats (not the mobile envelope):

- `GET /api/ticket/:token/status` and `GET /api/ticket/:token/events` (SSE) for the live ticket.
- `POST /api/feedback`.
- `GET /api/feedback/certificate/:token` (certificate JPEG).
- `POST /api/check-in/station` (cookie-based station proof; keep a per-station cookie jar).

## Organiser (auth)

All routes take `:orgSlug` and resolve the organisation server-side. An event
is visible when the caller is a member of the organisation or holds a
collaborator grant on that event (as on the event dashboard); anything else,
including an id from another organisation, is `NOT_FOUND`. A visible event
without the needed permission is `FORBIDDEN`.

`EventPermissions = { "checkIn", "manageRegistrations", "sendEmails", "schedule", "manageFeedback", "manageRegistrationWindow", "judge", "checkInToLists", "manageOrders", "fileClaims", "manageFinance" }`,
derived exactly as the event dashboard does: `checkIn` = organisation
OWNER/ADMIN or the event `CHECK_IN` grant; `schedule` = OWNER/ADMIN or
`PUBLISH_AND_SCHEDULE`; `judge` = OWNER/ADMIN or the `JUDGE` grant, on an
event with submissions switched on (the judging routes below);
`manageRegistrations` and `manageOrders` = OWNER/ADMIN or the
`MANAGE_REGISTRATIONS` grant (as the web guest list and payment tools);
`sendEmails`, `manageFeedback`, `manageRegistrationWindow` and `manageFinance`
= organisation OWNER/ADMIN; `checkInToLists` = OWNER/ADMIN or `CHECK_IN`;
`fileClaims` = anyone on the event dashboard. All come from
`eventCapabilities()` (lib/eventDashboard/capabilities.ts), the website's own
source (see [Permissions](PERMISSIONS.md#mobile-api)). The flags only hide controls; every
mutation is re-checked server-side.

`EventCounts = { "confirmed", "waitlisted", "pending", "pendingPayment", "crew", "checkedIn", "capacity|null", "capacityUsed" }`,
returned only when the caller has `manageRegistrations` or `checkIn`, else `null`.
`pendingPayment` counts paid places held while the buyer pays and `crew` the
crew tickets. `capacityUsed` is what `capacity` is compared with: on
individual events it is `confirmed` minus crew plus live payment holds, and on
team events it counts confirmed teams plus
confirmed solo registrants (`confirmed` stays a count of people). Show
`capacityUsed / capacity` for fill, not `confirmed / capacity`.

### `GET /orgs/:orgSlug/events?filter=upcoming|past|all`

Members see the organisation's standalone events (any status); collaborators
only their granted events. Upcoming is soonest first, the others newest first,
up to 200.
→ `{ "events": [EventSummary & { "counts": EventCounts|null, "myPermissions": EventPermissions }] }`.

### `GET /orgs/:orgSlug/events/:eventId`

`{ "event": EventSummary & { "privacyType", "registrationOpen", "registrationClosesAt|null", "registrationClosedReason|null", "registrationManuallyClosed", "feedbackOpen", "eventUrl", "shortUrl|null" }, "counts": EventCounts|null, "myPermissions": EventPermissions }`
(`registrationManuallyClosed`: sign-ups were closed from an app and can be reopened there).

### Guests

`Guest = { "rsvpId", "displayName", "email|null", "status", "checkedInAt|null", "registeredAt", "isGuest", "teamName"? }`
(`isGuest`: the registration has no account; `teamName`: on `TEAM` events,
the guest's team, absent for solo registrants). Guest rows never include
ticket tokens.

- `GET …/guests?status=ALL|CONFIRMED|WAITLISTED|PENDING_APPROVAL|REJECTED&checkedIn=any|yes|no&q=&cursor=&limit=`
  (limit 1–100, default 50, newest first) → `{ "guests": [Guest], "nextCursor" }`.
  Requires `manageRegistrations` or `checkIn`.
- `GET …/guests/:rsvpId` → `Guest & { "answers": [{ "label", "value" }] }` (same permission).
- `POST …/guests/:rsvpId/approve` · `…/reject` · `…/promote` → the updated
  `Guest`. Same rules, capacity transaction, emails and audit as `approveRsvp`
  / `rejectRsvp` / `promoteFromWaitlist` (organisation admins). A guest who
  belongs to a team is refused with `TEAM_MEMBER` (teams change status only
  as a whole, see Teams below).
- `POST …/guests/:rsvpId/reaccept` → the updated `Guest`. Reverses a decline
  (as `reacceptRsvp`; organisation admins): only a `REJECTED` guest, and only
  while the event is open. The guest becomes `CONFIRMED` when there is room
  and `WAITLISTED` otherwise (check the returned `status`), with the approval
  or waitlist email and a `RSVP_REACCEPTED` audit event. Any other status is
  `CONFLICT` ("Only declined registrations can be re-accepted."). Older apps
  that do not call it are unaffected; `approve` still accepts only pending
  requests. A member of a declined team is refused with `TEAM_MEMBER`.
- `POST …/guests` `{ "name", "email", "answers"? }` → `201` `Guest` (as `addManualRsvp`).
- `DELETE …/guests/:rsvpId` → `{ "undoId" }` (as `deleteRsvp`; the undo lasts five minutes).
- `POST …/guests/restore` `{ "undoId" }` → `null` (as `restoreRsvp`). `NOT_FOUND`
  unless the undo was created by the caller for this same event.

### Teams (`TEAM` events)

The web Guests → Teams view. Permission: `canManageRegistrationsFor`
(organisation OWNER/ADMIN or the event's `MANAGE_REGISTRATIONS` grant), the
same check as on the web; a visible event without it (for example a
`CHECK_IN`-only collaborator) is `FORBIDDEN`, and a `JUDGE`-only collaborator
gets `NOT_FOUND` like every organiser route.

`Team = { "id", "name", "status", "size", "minSize|null", "maxSize|null", "incomplete", "lookingForMembers", "leaderDisplayName|null", "members": [{ "rsvpId", "displayName", "isLeader", "checkedIn" }] }`
(`incomplete`: below `minSize`, cannot be approved). Organisers see full
names; no emails, answers, tokens or team links (use `GET …/guests/:rsvpId`
with a member's `rsvpId` for contact details).

- `GET …/teams?status=ALL|CONFIRMED|WAITLISTED|PENDING_APPROVAL|REJECTED|INCOMPLETE|LOOKING&q=&cursor=&limit=`
  (limit 1–100, default 50; oldest team first, opaque keyset cursor; `q` up to
  100 characters matches team names and members' names and emails, wildcards
  literal) → `{ "teams": [Team], "nextCursor", "counts": { "ALL", "CONFIRMED", "WAITLISTED", "PENDING_APPROVAL", "REJECTED", "INCOMPLETE", "LOOKING" } }`.
  The counts cover the whole event. The query is the dashboard's
  (`listEventTeamsForOrganiser`) on the `search` rate-limit bucket.
- `POST …/teams/:teamId/approve` · `…/reject` · `…/promote` → the updated
  `Team`. The whole team and every member RSVP change in one transaction under
  the event lock (`transitionTeamStatus`, shared with the dashboard through
  `lib/core/teamOrganiser.ts`), with one status email and webhook per member,
  a `TEAM_APPROVED` / `TEAM_REJECTED` / `TEAM_WAITLIST_PROMOTED` audit and the
  `rsvp` rate limit. Refusals: `TEAM_INCOMPLETE` (approve below the minimum
  size), `CAPACITY_FULL` (approve or promote with no free unit), `CONFLICT`
  (wrong status, event closed for approvals, or changed by another
  organiser), `NOT_FOUND` (a team of another event or organisation).

### Check-in (the event `CHECK_IN` permission, checked by the shared core)

`CheckInResult = { "rsvpId", "displayName", "email|null", "status", "alreadyCheckedIn", "checkedInAt|null", "checkInDetails": [{ "label", "value" }], "registrationDetails": [{ "label", "value" }], "teamName"? }`
`CheckInPreview = CheckInResult & { "gate": { "ok": true } | { "ok": false, "reason", "needsForce", "blocked"? } }`

- `POST …/check-in/preview` `{ "rawInput": "<QR payload, ticket URL or typed code>" }` or `{ "rsvpId" }` → `CheckInPreview`.
- `POST …/check-in` `{ "rawInput"?: "…", "rsvpId"?: "…", "force": false }`
  (exactly one of `rawInput`/`rsvpId`) → `CheckInResult`; `NEEDS_FORCE` when a
  waitlist override is possible (retry with `force: true`).
- `POST …/check-in/undo` `{ "rsvpId" }` → `null`.
- `GET …/check-in/lookup?q=` (min 2 chars, max 12 rows) → `{ "rows": [Guest] }`.
  Matches guest names and emails and, on team events, team names (teams of the
  same event only, listing their members). Rows carry `teamName`.
- `GET …/check-in/stats` → `{ "confirmed", "checkedIn", "recent": [{ "rsvpId", "displayName", "checkedInAt" }] }` (ten latest).
- `GET …/check-in/roster` → `{ "generatedAt", "rows": [Guest & { "ticketToken", "checkInDetails", "registrationDetails" }] }` (rows carry `teamName` like `Guest`)
  (as `downloadOfflineCheckInRoster`: confirmed, waitlisted and pending). The
  roster holds every guest's ticket token, so a lost phone holds working
  tickets: keep it only in encrypted app storage (Android Keystore-backed
  EncryptedFile, iOS Data Protection `complete`), never in backups or logs,
  and delete it when the event ends, on sign-out and when a refresh fails.
  "Sign out everywhere" (`POST /auth/logout-all`) is the remote wipe: the app
  must delete its roster and tokens when its next call answers
  `UNAUTHENTICATED`.
- `POST …/check-in/sync` `{ "checkIns": [{ "rsvpId", "checkedInAt", "force", "clientMutationId"? }] }` (1–500)
  → `{ "syncedIds", "alreadyCheckedInIds", "failed": [{ "rsvpId", "error" }] }`
  (as `syncOfflineCheckIns`, same operating-window rule).

All check-in writes go through `commitCheckInProjection` /
`commitUndoCheckInProjection`, so the live ticket tears off exactly as for web
check-ins. History sources: `mobile-scan` (by `rawInput`), `mobile-manual` (by
`rsvpId`, and undo), `offline-sync`.

### Emails (organisation admins, as on the web)

- `GET …/broadcasts/meta` → `{ "templates": [{ "id", "group", "name", "description", "subject", "bodyHtml", "audience": { "statuses", "attendance" } }], "designs": [{ "id", "label", "description" }], "placeholders": ["{{name}}", …], "history": [{ "id", "subject", "design", "audience": { "statuses", "attendance" }, "recipientCount", "sentAt", "bodyHtml" }] }` (20 latest).
- `POST …/broadcasts/count` `{ "statuses": [...], "attendance": "ANY|CHECKED_IN|NOT_CHECKED_IN" }` → `{ "count" }`.
- `POST …/broadcasts/preview` `{ "subject", "body", "design" }` → `{ "subject", "html", "text" }`
  (server-rendered with example values and absolute image URLs; show it in a
  web view with JavaScript disabled).
- `POST …/broadcasts/test` `{ "subject", "body", "design" }` → `{ "to" }` (the caller's own verified inbox).
- `POST …/broadcasts` `{ "statuses", "attendance", "subject", "body", "design" }` → `201` `{ "broadcastId", "recipientCount" }`.

`design` is one of `classic`, `minimal`, `accent`, `photo`, `letter` (default
`classic`). Bodies are sanitised on the server with `sanitizeBroadcastHtml`;
editors should produce only the supported subset (p, strong, em, h2, h3, ul,
ol, li, blockquote, a, a.cta, br). Apps implement a short undo by delaying the
send call client-side.

### Day-of controls

- `GET …/schedule` (any organiser of the event, including a `CHECK_IN`-only
  collaborator) → `{ "generatedAt", "tracks": [{ "id|null", "name", "sessions": [ScheduleSession] }] }`.
  `ScheduleSession = { "id", "title", "type", "visibility": "DRAFT|PUBLISHED|HIDDEN", "startDateTime", "endDateTime", "delayMinutes", "effectiveStartDateTime", "effectiveEndDateTime", "speakers": [{ "id", "name", "headline|null", "organisation|null", "photoUrl|null" }] }`.
  Every session whatever its visibility, with planned times, its stored delay
  and the effective times after the delays of earlier sessions in the same
  track (`effectiveEventProgram`, as on the public page). Speakers are listed
  in session order whatever their visibility, without bios or links. The app
  keeps the last copy for offline use; `generatedAt` says how fresh it is.
  Before this change the route required `schedule` and returned only the
  planned fields; older apps ignore the new fields.
- `POST …/schedule/sessions/:sessionId/delay` `{ "delayMinutes": 0..1440 }` → `null`
  (as `setEventSessionDelay`; requires `PUBLISH_AND_SCHEDULE` or organisation admin).
- `POST …/feedback/state` `{ "open": bool }` → `{ "open" }`. Saves through the
  shared feedback-settings function with every other setting unchanged;
  organisation admins only. Opening needs at least one question (`CONFLICT` otherwise).
- `POST …/registration/state` `{ "open": bool }` → `{ "registrationOpen", "registrationClosesAt|null", "registrationClosedReason|null", "registrationManuallyClosed" }`.
  Closing stores the organiser's configured cutoff (fixed time or lead
  minutes) and sets `registrationClosesAt` to the earlier of now and the event
  start, so the event still satisfies the website's "close on or before the
  start" rule. Reopening is allowed only after such a close
  (`registrationManuallyClosed: true`, otherwise `CONFLICT`) and restores the
  stored cutoff exactly; if that cutoff has itself passed, the response says
  `registrationOpen: false` with the reason. Saving the event form on the
  website discards the stored cutoff (the form's value wins). Organisation
  admins only (the same permission as editing the event on the web), rate
  limited, revalidated and audited as `EVENT_REGISTRATION_CLOSED` /
  `EVENT_REGISTRATION_REOPENED`.

### Orders at the desk (`manageOrders`: MANAGE_REGISTRATIONS)

- `GET …/orders/:orderId` → buyer, total, paid, refunded, still `due`,
  `payAtDesk` and the tickets. Guests carry `orderId` in every guest list.
- `POST …/orders/:orderId/settle` `{ "mode": "offline"|"waive", "method?", "reference?" }`
  records money collected in person or makes the order complimentary.
- `POST …/orders/:orderId/payment-link` emails the buyer a fresh link.
- `POST …/orders/:orderId/refund` `{ "amount?", "reason", "cancelTickets?" }`
  refunds through the provider.
- The check-in preview adds `payment` (`{ "due|null", "orderId", "payAtDesk" }`)
  so the desk can collect before checking in; a `PENDING_PAYMENT` ticket is
  refused by the status gate.
- Approving a paid request, promoting a paid waitlist entry and reaccepting a
  declined paid order offer the place: the guest stays `PENDING_PAYMENT` and
  carries `"paymentOutcome": "LINK_SENT"`. Rejecting a paid order refunds it
  (`"paymentOutcome": "REFUNDED"`). Removing a guest whose ticket was part of a
  paid order answers `PAID_ORDER`; refund the order instead.

### Check-in lists (`checkInToLists`: CHECK_IN)

- `GET …/check-in-lists` → the event's open custom lists in desk order.
- `POST …/check-in-lists/:listId/check-in` `{ "rawInput" | "rsvpId", "force?" }`
  and `POST …/check-in-lists/:listId/undo` `{ "rsvpId" }`, with the desk's
  rules (entry check-in first where the list asks). Recorded as
  `mobile-scan` or `mobile-manual`.

### Finance (docs/FINANCE.md)

- `fileClaims` (anyone on the dashboard): `GET …/finance/claims/mine`,
  `POST …/finance/claims` (multipart: `category`, `description`, `amount`,
  `payeeName`, `payeeEmail`, up to three `receipts`), and
  `POST …/finance/claims/:claimId/withdraw`.
- `manageFinance` (organisation owners and admins): `GET …/finance/claims`
  (every claim and refund request), `POST …/finance/claims/:claimId/approve`
  `{ "amount?", "note?" }`, `POST …/finance/claims/:claimId/reject`
  `{ "note?" }` and `POST …/finance/refund-requests/:requestId/decide`
  `{ "decision": "approve"|"decline", "amount?", "cancelTickets?", "note?" }`.
  Decisions are held to the event in the path. Recording payouts, the budget
  and participant-claim settings stay on the website.

### Event crew (`manageCrew`: MANAGE_REGISTRATIONS)

Crew ([CREW.md](CREW.md)) hold free crew tickets: confirmed, counted in
`confirmed` and `crew`, never against capacity (`capacityUsed` leaves them
out), never paid and never in teams. Guests and the caller's own
registrations carry `isCrew: true`.

- `GET …/crew` → `{ "members": [{ "id", "name", "email", "role", "foodPreference", "showOnPage", "joinedViaLink", "rsvpId", "checkedInAt|null" }], "food": [{ "label", "count" }] }`.
- `POST …/crew` `{ "name", "email", "role?", "foodPreference?" }` → `201`, the
  list, by Guests → Crew's own action (it never converts a paid ticket, a team
  member or an entrant, and emails the crew ticket).
- `DELETE …/crew/:memberId` removes the member and their crew ticket.

The crew sign-up link, photos and crew expense claims stay on the website.

### Pending

Attendance confirmation, judging rounds, the Mentor Desk and volunteer shifts
arrive with those features: attendance replies, round-scoped judging lists
and finalists, the help queue and mentor console, and shift sign-up and
check-in. The routing, DTO and permission layer above is shaped
for them (`eventRoute` requirements, `eventPermissionsFor`, `forUser`).

## Judging (judges)

The web judge workspace ([Hackathon judging](HACKATHON.md)). Who may judge is
`resolveJudgeContext`: organisation OWNER/ADMIN, or the event's `JUDGE`
grant (also a `JUDGE`-only collaborator, who has no other organiser route).
An event outside what the caller can see, including another organisation's,
is `NOT_FOUND`; an event the caller sees as an organiser without the right to
judge is `FORBIDDEN`; an event without submissions switched on is
`NOT_FOUND`. Every call re-resolves the judge, and the cores re-check
visibility, the judging status and the rubric inside their transactions.
Rate limits are the web judge actions' (`search` bucket for the list, `action`
for the rest).

Judges see project content and display names only: never entrant emails,
answers, ticket links, disqualification reasons or status, other judges'
scores or comments, results or ranks. A judge whose account owns a
registration of an entrant never sees or scores that project (conflict of
interest).

`JudgeSubmission = { "id", "title", "summary", "links": { "repo|null", "demo|null", "video|null" }, "entrantName", "teamName"?, "myReview": { "status": "NONE|DRAFT|SUBMITTED", "scoredCriteria" } }`
(`entrantName`: the team name, or a solo entrant's first name and last
initial; `teamName` only for teams; `DRAFT` once any score or comment is
saved). `Criterion = { "id", "name", "description", "weight", "maxScore" }`.
`JudgeSubmissionDetail = { "judgingStatus", "criteria": [Criterion], "submission": JudgeSubmission, "myScores": [{ "criterionId", "score" }], "myComment|null", "mySubmittedAt|null" }`.

- `GET …/judging/submissions?filter=all|todo|inProgress|reviewed&q=&cursor=`
  → `{ "judgingStatus", "submissions": [JudgeSubmission], "nextCursor", "counts": { "all", "todo", "inProgress", "reviewed" } }`.
  25 per page, oldest submission first (opaque keyset cursor). Only projects
  this judge may score: `SUBMITTED`, assigned unless the organisers let judges
  see all, no conflict of interest. `todo` includes `inProgress`. `q` (up to
  100 characters) matches the title, team name, or a solo entrant's first
  name. `counts` ignore the search.
- `GET …/judging/next` → `{ "next": JudgeSubmissionDetail|null, "remaining" }`:
  "Score next project" picked on the server (one the judge started, then the
  fewest submitted reviews, then the oldest). `next` is null when nothing is
  left or judging is not `OPEN`.
- `GET …/judging/criteria` → `{ "judgingStatus", "criteria": [Criterion] }`.
- `GET …/judging/submissions/:submissionId` → `JudgeSubmissionDetail`, with
  only the caller's own scores and private comment; `NOT_VISIBLE` for a
  project the caller may not score. Every judging route returns `NOT_FOUND`
  once the event no longer takes submissions.
- `PUT …/judging/submissions/:submissionId/scores` `{ "scores": [{ "criterionId", "score" }], "comment"?: "…" }`
  → `{ "scored", "total", "myReview": { "status", "scoredCriteria" } }`. Saves
  some or all scores (whole numbers, 0 to the criterion's `maxScore`, each
  criterion once) and, with `comment` (up to 2000 characters), the private
  comment as a draft; nothing is submitted. Refusals: `JUDGING_CLOSED`,
  `NOT_VISIBLE`, `INVALID_REQUEST` (unknown criterion or out of range).
- `POST …/judging/submissions/:submissionId/review` `{ "scores"?: […], "comment"?: "…" }`
  → `JudgeSubmissionDetail`. Saves `scores` first (as the web "Submit review"),
  then submits the review once every criterion is scored. Without `comment`
  the saved draft comment is kept. Refusals: `JUDGING_CLOSED`,
  `INCOMPLETE_SCORES` (scores already saved stay saved), `NOT_VISIBLE`.

Comments are private to organisers; judges cannot see each other's work.

## App links

Both association files are served without redirects and claim nothing until
configured:

Both are read at runtime from the environment (one release image serves every
installation, so nothing is compiled in) and are served by the website host,
which also serves them in a split installation.

- `GET /.well-known/assetlinks.json` — Android App Links for the package in
  `ANDROID_APP_PACKAGE_NAME` (default `in.spaceworks.events`), from `ANDROID_APP_SHA256_FINGERPRINTS`
  (comma-separated `AA:BB:…` SHA-256 signing-certificate fingerprints); `[]`
  when unset. It only proves the domain; the app's manifest decides the paths.
- `GET /.well-known/apple-app-site-association` — iOS Universal Links for
  the apps in `APPLE_APP_IDS` (comma-separated `TEAMID.bundle.id`), served as
  `application/json` with no file extension;
  `{ "applinks": { "details": [] } }` when unset. It uses `components`, with the
  exclusions below listed before the claimed paths.

Both apps should open exactly these paths:

| Claimed | Meaning |
| --- | --- |
| `/ticket/*` | Attendee ticket |
| `/*/*/feedback` | Event feedback form |
| `/*/*` | Event page (`/:orgSlug/:eventSlug`) |

Never claimed (they stay in the browser):

`/api/*`, `/_next/*`, `/.well-known/*`, `/dashboard` and `/dashboard/*`,
`/account` and `/account/*`, `/super-admin`, `/super-admin/*`,
`/verify-mfa`, `/login`, `/reset-password`, `/verify-email` (and their
sub-paths), `/join/*`, `/embed/*`, `/help` and `/help/*`, the bearer links
`/order/*` (buyer orders), `/verify/*` (member ID checks), `/team/*`,
`/submit/*`, `/attend/*` and `/crew/*`, the member ID pages `/*/ids` and
`/*/ids/*`, `/*/*/check-in` (the venue kiosk), `/*/i/*` (series
occurrences), `/*/*/schedule`, `/*/*/sessions/*`, `/*/*/speakers/*`,
`/*/*/team/*`, `/*/*/projects` and `/*/*/results` (and their sub-paths).

Event short links (`/:shortCode`, seven characters with at least one uppercase
letter) are **not** claimed: Apple's patterns cannot require the uppercase
letter, so a `/???????` pattern would also capture seven-character
organisation pages. A short link opens the website, which redirects to the
event page; apps that receive a short code another way can resolve it with
`GET /public/short/:code`.

For the Android manifest, declare the three claimed shapes (for example
`android:pathPrefix="/ticket/"` and `android:pathAdvancedPattern` entries for
`/[^/]+/[^/]+` and `/[^/]+/[^/]+/feedback`), and in the activity reject the
excluded first segments (`api`, `_next`, `.well-known`, `dashboard`,
`account`, `super-admin`, `verify-mfa`, `login`, `reset-password`,
`verify-email`, `join`, `embed`, `help`, `order`, `verify`, `team`, `submit`,
`attend`, `crew`) and second segments `i`, `ids` and `check-in`, `schedule`,
`team`, `projects`, `results` by handing the URL back to the browser, since
manifest filters cannot express exclusions.
