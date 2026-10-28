# Routes and HTTP endpoints

[Documentation index](README.md)

Dynamic segments are shown as `:name` for readability.

## Public pages

| Route | Purpose |
| --- | --- |
| `/` | Landing page |
| `/about`, `/features` | Product story and feature overview |
| `/privacy`, `/terms` | Privacy policy and terms of use |
| `/help`, `/help/:section/:article` | The in-app guide (`content/help`, MDX): search, section navigation and articles. Sections for organisation owners and admins (`developers/*`) and for the super admin (`instance/*`, `installation/*`) are listed only for those readers and are a real 404 for everyone else; this is a reading convenience, not authorization. Unknown articles are a 404. Signed-in requests are `no-store` like every signed-in page |
| `/discover` | Paginated public event discovery |
| `/search` | Public event search UI |
| `/:orgSlug` | Public organisation page |
| `/:orgSlug/:eventSlug` | Public event details and RSVP |
| `/embed/:orgSlug/:eventSlug` | Framable public event details and RSVP for a host website |
| `/:orgSlug/:eventSlug/feedback` | Event feedback form when open |
| `/:orgSlug/:eventSlug/projects` | Hackathon project gallery ([Hackathon judging](HACKATHON.md)): submitted projects' titles, summaries, team or entrant names, and links, once the submission window has closed and the organiser made the gallery public. `?q=` search, `?sort=newest\|az\|awards`, `?filter=winners` and award badges (the last two once results are published), `?page=N`; invalid values fall back to the defaults. Same access rules as the event page; otherwise a real 404 |
| `/:orgSlug/:eventSlug/results` | Hackathon results: awards, places, winning project titles, team or entrant names, and links, once the organiser has published results, with a `?q=` search once more than 10 winners are listed. Never scores or judge comments. Same access rules as the event page; otherwise a real 404 |
| `/:orgSlug/:eventSlug/team/:joinToken` | Team join link ([Team registration](TEAMS.md)): the registration form with the team fixed. Same access rules as the event page; shows only the team name, size and maximum size; unknown, retired and other events' tokens are a 404; a signed-in person's own solo registration for the event (or a ticket this browser remembers) can join the team instead of registering again; `noindex`, `no-referrer` |
| `/:orgSlug/:eventSlug/check-in` | PIN-protected venue check-in station; usable by trusted on-site staff without an account |
| `/:orgSlug/i/:instanceId` | Recurring-series instance and RSVP |
| `/:shortCode` | Event short link: a 7-character code (letters and digits, always at least one uppercase letter, so it never matches a lowercase organisation slug) that temporarily redirects to the event's current public page. Unknown or unpublished codes return the same not-found page as an unknown organisation; lookups are rate-limited |
| `/ticket/:token` | Attendee ticket status and QR page; tears off the QR stub live when the attendee is checked in. On a team event it also shows the team (name, leader, member names), leaving the team, **Join a team** with a pasted join link for a solo registration, and the *Looking for a team* profile and list. A crew ticket ([Event crew](CREW.md)) shows a **Crew** chip and no cancel, payment, transfer, team or project controls, and **Claim expenses** when the event takes crew claims |
| `/attend/:token` | Attendance confirmation form ("Are you still coming?", [Attendance confirmation](ATTENDANCE.md)), opened from the organiser's attendance email or a link an owner/admin shared by hand. The 43-character base64url token (256 bits) is stored only as a SHA-256 hash; a reminder or a new shared link replaces it, retiring the old link. `?answer=yes\|no` preselects an answer and never submits it. Shows the event summary and only this registration's own name, email and team; never other attendees, the ticket or check-in token. Closed after the start, when the event is cancelled, or when the registration is no longer confirmed. A No with release on frees a free place, cancels a paid single ticket under the buyer refund policy, or opens a refund request. Unknown, malformed, replaced and released tokens are a real 404; `noindex`, `no-referrer`, `private, no-store`; site chrome |
| `/submit/:token` | A solo registrant's project page, opened by the emailed submission link (requested from the ticket page; stored only as a SHA-256 hash; requesting a new one retires the old link). Draft, submit, edit while the window is open, and withdraw. Unknown and retired tokens are a 404; `noindex`, `no-referrer`, never cached |
| `/crew/:token` | Crew sign-up link ([Event crew](CREW.md)): the crew profile form for one event, showing only the event and organisation names and date. Malformed, rotated and disabled tokens are a 404; closed for cancelled and ended events. New members start hidden from the event page and get a free crew ticket by email; an email already on the crew or registered gets the same answer as a new sign-up and nothing changes. Generic metadata, `noindex`, `no-referrer`, never cached, disallowed in `robots.txt` |
| `/team/:token` | Team page for the leader ([Team registration](TEAMS.md)), opened by the opaque management token (stored only as a SHA-256 hash; regenerating it retires the old link). A signed-in leader reaches the same page at `/account/teams/:teamId` without the token. `noindex`, private cache, `no-referrer`; the ticket's check-in token never opens it |
| `/order/:token` | The buyer's order (opaque access token): lines, discount and total, payment state with "Pay now" while the tickets are held, refunds, the refund policy it was bought under with "Cancel order" while that policy allows it, and each ticket with its attendee's details |
| `/:orgSlug/ids` | An organisation's ID programmes that are taking card requests |
| `/:orgSlug/ids/:programmeSlug` | Member ID join form (sign-in required; only while the programme is active with requests open) and the requester's own status |
| `/verify/:token` | Public member ID check (QR target): Valid / Expired show name, photo, programme, organisation, ID number and valid-until; Revoked shows status only; pending, rejected and unknown tokens share one "Card not found". `noindex`, `no-referrer`, rate limited per IP |
| `/join/org/:token` | Accept an organisation invitation |
| `/login` | Password and Google sign-in/signup; asks for an authenticator code, or an emailed six-digit code for a new device or after repeated failures |
| `/verify-mfa` | Authenticated: organisation staff who signed in without an authenticator code (Google) confirm one; sets a 12-hour proof cookie and returns to a safe `next` path. Staff without an authenticator go to `/account/security?mfa=required`; anyone else goes straight on |
| `/verify-email` | Consume a one-time email-verification link and activate a password account |
| `/reset-password` | Password-reset request and completion |
| `/account` | Authenticated account profile settings |
| `/account/security` | Authenticated password, MFA, recovery-code, and session controls |
| `/account/registrations` | Authenticated list of the signed-in user's own registrations, tickets, certificates, and personal data download |
| `/account/teams/:teamId` | Authenticated team page for the team's signed-in leader (linked from `/account/registrations`); a 404 for anyone else. Same controls as `/team/:token` except resetting the management link; `noindex`, private cache |
| `/account/submissions/:eventId` | Authenticated project page for a signed-in entrant (any member of a team, or the owner of a solo registration), linked from `/account/registrations` and the ticket. A 404 for anyone without a registration on the event; `noindex`, `no-referrer` |
| `/account/ids` | Authenticated ID wallet: the user's own member ID cards (linked to the account, or issued to its verified email) with a holographic flip viewer and downloads |
| `/account/organisations` | Authenticated list of the user's memberships and roles, event co-organiser roles, pending co-organiser invites, and leave-organisation control (blocked for the sole owner) |

## User and organisation dashboard

| Route | Purpose |
| --- | --- |
| `/dashboard` | User's organisations |
| `/dashboard/security` | Legacy redirect to `/account/security` |
| `/dashboard/org/new` | Create an organisation |
| `/dashboard/:orgSlug` | Organisation events and series |
| `/dashboard/:orgSlug/settings` | Organisation settings |
| `/dashboard/:orgSlug/settings/payments` | Owner only: connect the organisation's own Razorpay or Stripe account (write-only, encrypted keys), copy webhook addresses, test the connection |
| `/dashboard/:orgSlug/settings/email` | Owner only: sender name and reply-to for the organisation's guest email, or its own SMTP server (tested before use, write-only encrypted password) |
| `/dashboard/:orgSlug/settings/chat` | Owners and admins: connect Slack, Discord, Mattermost, Telegram or WhatsApp for notifications, choose what each hears about, send a test (webhook addresses and tokens write-only and encrypted) |
| `/dashboard/:orgSlug/ticket-designs` | Owners and admins: the organisation's ticket design library, new designs from starters, the default design (docs/TICKET_DESIGNER.md) |
| `/dashboard/:orgSlug/ticket-designs/:designId` | The ticket designer: library templates for owners and admins, an event's designs for its `EDIT_DETAILS` editors; 404 otherwise |
| `/dashboard/:orgSlug/members` | Members, roles, and invitations |
| `/dashboard/:orgSlug/ids` | Member ID programmes (all members read; owners/admins create) |
| `/dashboard/:orgSlug/ids/:programmeId` | Programme members (approve, reject, revoke, renew, email, download), import (CSV or public Google Sheet with column mapping), front/back card designer and settings; owners/admins only except the read-only member list |
| `/dashboard/:orgSlug/event/:eventId` | Event overview, attendees, forms, invites, and feedback; plus **Judging** (`?tab=judging`) for hackathon submissions, rubric, judges, progress and automatic assignment (`&sub=judging-progress`), awards and results, shown only once the event uses judging. A co-organiser whose only grant is `JUDGE` sees just the judging workspace. The paged lists keep their filters in the query string too (saved views, allow-listed per list: People `status`/`kind`/`team`/`q`, Teams `status`/`q`, Submissions `status`/`q`, Results `scored`/`q`, Progress `show`; e.g. `?tab=guests&sub=people&status=waitlist`); the filters never grant access. Guests → Crew (`?tab=guests&sub=crew`) manages the [event crew](CREW.md) and its sign-up link |
| `/dashboard/:orgSlug/event/:eventId/schedule` | Standalone-event programme planning and live delay management |
| `/dashboard/:orgSlug/event/:eventId/check-in` | Online/offline check-in station; organisation admin or exact event `CHECK_IN` grant. `?list=<id>` opens the desk for one open custom check-in list instead of entry |
| `/dashboard/:orgSlug/series/:seriesId` | Recurring-series management |
| `/dashboard/:orgSlug/settings/webhooks` | Outgoing webhook endpoints (owners and admins); add, and the secret shown once |
| `/dashboard/:orgSlug/settings/webhooks/:endpointId` | One endpoint: edit, rotate secret, send test, enable/disable, delete, and the last 50 deliveries with Redeliver (owners and admins; another organisation's id is a 404) |

Dashboard pages require authentication and enforce membership/role permissions on the server. Organisation staff must also have an authenticator app: without one they are sent to `/account/security?mfa=required`, and without an authenticator check in this session to `/verify-mfa` (unless `STAFF_MFA_REQUIRED=false`).

## Super-admin pages

The `/super-admin` area includes overview, activity, audit log, auth, email, events, invites, monitoring, operations, organisations (with a detail page per organisation), security, settings, storage, and users (with a detail page per user at `/super-admin/users/:userId`). The Auth page includes the instance-wide new-account creation control. `/super-admin/settings` manages SMTP, Google SSO, the paid events switch (off by default), displayed backup posture, and the operational alerts webhook; secrets (including the webhook URL) entered there are write-only. Access requires the authenticated email configured in `SUPER_ADMIN_EMAIL`; other users receive a not-found response.

The super admin signs in with email and password; there is no separate authenticator step-up. Each `page.tsx` calls `requireSuperAdminMfa()` itself, which now checks super-admin access only, because layout checks do not re-run on client navigation (`tests/unit/super-admin-page-guards.test.ts` enforces this).

## Public and application APIs

| Method and route | Authentication | Purpose |
| --- | --- | --- |
| `POST /api/rsvp` | Optional session | Submit an event or instance RSVP; on a team event the optional `team` field creates a team, joins one by join token, or registers solo |
| `POST /api/feedback` | Public, rate-limited | Submit feedback; email is used only for certificate-enabled forms |
| `GET /api/exports/member-ids/:programmeId/cards/:memberId` | Session; programme organisation OWNER/ADMIN | One approved member's card: `format=pdf` (two pages, front and back) or `format=png&side=front|back` (300 dpi); audited, `no-store` |
| `GET /api/exports/member-ids/:programmeId/cards` | Session; programme organisation OWNER/ADMIN | Every approved card as one PDF (up to 500) or `format=zip` with one PDF per member (up to 200); one bulk render per process; audited |
| `GET /api/exports/account/ids/:memberId` | Session; the card's own holder | The signed-in user's own approved card as PDF or PNG |
| `POST /api/check-in/station` | PIN-scoped station session, rate-limited | Open and operate a venue check-in station |
| `GET /api/search?q=...` | Public, rate-limited | Return matching public events |
| `GET /api/help/search-index` | Optional session, global API rate limit | Plain text of every guide article the viewer may read, searched in the browser; restricted sections only for owners/admins or the super admin; `private, no-store` |
| `POST /api/client-errors` | Public, same-origin, rate-limited per IP (`clientError`, 10/min), 4 KB body cap | Browser crash report from the app error boundaries; forwarded (redacted) to the alert webhook when configured. Always an empty `204` |
| `GET /api/ticket/:token/download` | Opaque token | Download the attendee ticket |
| `POST /api/ticket/:token/checkout` | Opaque token, rate-limited per IP (`ticketCheckout`, 20/min) | "Pay now" for a held ticket: opens (or reuses) the hosted checkout for its whole order and returns only that address (`no-store`) |
| `POST /api/orders/:token/checkout` | Opaque order access token, rate-limited per IP (`ticketCheckout`) | "Pay now" on the buyer's order page |
| `GET /api/payments/return/:orderId?e=…&s=…` | Signed, 24-hour link (HMAC under a `MFA_ENCRYPTION_KEY` subkey) | Where Razorpay and Stripe send the buyer after checkout; redirects to `/order/:token?payment=return`, so the order's access token never reaches the provider |
| `GET /api/ticket/:token/status` | Opaque token, rate-limited per IP (`ticketStatus`, 120/min) | Return only `{ checkedIn, checkedInAt }` for the ticket (`no-store`, `no-referrer`; empty 404 for unknown tokens) |
| `GET /api/ticket/:token/events` | Opaque token, rate-limited per IP (`ticketEvents`, 60/min) | Server-Sent Events: initial `state`, then one `checked-in` event when the attendee is admitted; `: ping` every 25 s, closes after at most 10 minutes |
| `GET /api/feedback/certificate/:token` | Opaque token | Download an eligible JPEG certificate |
| `GET /api/exports/events/:eventId/attendees` | Authenticated organisation admin or event collaborator with `MANAGE_REGISTRATIONS` | Audited (`ATTENDEE_LIST_EXPORTED`, surface and filter names only) attendee CSV: every registration without parameters; with the Guests · People filters (`status`, `kind`, `team`, `attendance`, `q`) only the matching ones, same columns, ending with **Attendance confirmation** and **Attendance note**; streamed in keyset batches of 500; `private, no-store`, empty 404 otherwise (also for a malformed filter) |
| `GET /api/exports/events/:eventId/teams` | Authenticated organisation admin or event collaborator with `MANAGE_REGISTRATIONS`, TEAM events | Audited (`TEAM_LIST_EXPORTED`, filter names only) Guests · Teams CSV for the view's `status` and `q`: team, status, size, incomplete, looking for members, leader and email, members, submission status, created; read through the Teams query in keyset batches of 200; `private, no-store`, empty 404 otherwise |
| `GET /api/exports/events/:eventId/attendee-emails` | Authenticated organisation admin or event collaborator with `MANAGE_REGISTRATIONS` | Audited (`ATTENDEE_LIST_EXPORTED`, format `emails`) unique names and emails for every registration matching the Guests · People filters (`status`, `kind`, `team`, `q`); `private, no-store`, empty 404 otherwise |
| `GET /api/ticket/:token/design` | Bearer ticket token (confirmed registrations) | The designed ticket (docs/TICKET_DESIGNER.md): PNG by default, `?format=pdf` for the PDF, `?inline=1` to show it on the ticket page; rate limited per address; `private, no-store`; empty 404 otherwise |
| `GET /api/ticket-designs/:designId/preview` | Whoever may edit the design (library: organisation owner or admin; event design: `EDIT_DETAILS`) | The editor's server-rendered preview PNG with sample values, or (event designs) `?rsvp=` for one of the event's registrations; the QR is a sample; `private, no-store`; empty 404 otherwise |
| `GET /api/exports/events/:eventId/finance` | Authenticated organisation owner or admin | Audited (`EVENT_FINANCE_EXPORTED`) Finance CSV (docs/FINANCE.md): every payment in, refund, expense claim payment and prize payout, reversals included, signed and oldest first; `private, no-store`, empty 404 otherwise |
| `GET /api/claims/receipts/:receiptId` | The claim's organisation owner or admin, or the signed-in person who filed it | One expense claim receipt photo (WebP) from private storage; `private, no-store`, rate limited, empty 404 for every denial |
| `GET /api/exports/events/:eventId/judging` | Authenticated organisation owner or admin | Audited (`JUDGING_SCORES_EXPORTED`) judging scores CSV: one row per judge review with the rank and result score, plus both the raw and the adjusted score, judge names, no emails or comments. Results filters: `q` (search; ranks stay those of the whole ranking), `scored`, and `method` (`RAW`/`ZSCORE`, the method the table shows; the saved one when omitted). `view=submissions` exports Judging → Submissions instead (`status`, `q`; `status=notSubmitted` lists entrants without a submitted project), audited `JUDGING_SUBMISSIONS_EXPORTED`. Streamed in batches of 200 projects; audits record filter names only; `private, no-store`, empty 404 otherwise (also for a malformed or other-view parameter) |
| `GET /api/exports/account` | Authenticated user (own data only), rate limited per user (`dataExport`, 5/hour) | Audited (`ACCOUNT_DATA_EXPORTED`) personal JSON export; excludes secrets, hashes, and all bearer tokens |
| `GET /api/uploads/:key` | Public application route | Stream an allowlisted organisation WebP derivative with immutable/nosniff response controls |
| `/api/auth/*` | Auth.js | Session, provider, callback, and credential endpoints |
| `GET /api/v1/events` | Machine bearer credential + `events:read` | Paginated tenant event metadata |
| `GET /api/v1/events/:eventId` | Machine bearer credential + `events:read` | Tenant-scoped event metadata |
| `GET /api/v1/events/:eventId/orders` | Machine bearer credential + `orders:read` | Paginated order totals for one event; no buyer contact data, links or provider IDs |
| `GET /api/v1/events/:eventId/participants` | Machine bearer credential + `participants:read` | Paginated minimal confirmed-participant roster, with attendance filtering; `include=attendance` also requires `participants:attendance:read` |

Opaque ticket, certificate, team join, team management, submission, and crew sign-up URLs are bearer capabilities. Do not log them or place them in analytics payloads.

## Health and recovery APIs

| Method and route | Protection | Purpose |
| --- | --- | --- |
| `GET /api/health` | Public | Process liveness without database or Redis dependency |
| `GET /api/health/db` | `Authorization: Bearer $HEALTHCHECK_SECRET` | Database readiness check |
| `POST /api/internal/outbox` | `Authorization: Bearer $CRON_SECRET` | Run every timed job once (payment maintenance, waitlists, event reminders, backup alerts, retention), then deliver queued email |

## Payment webhooks

| Method and route | Protection | Purpose |
| --- | --- | --- |
| `POST /api/webhooks/razorpay/:webhookPathId` | `X-Razorpay-Signature` HMAC over the raw body with the addressed organisation's own webhook secret; `paymentWebhook` bucket (600/min per IP) instead of the global one | Razorpay settlement and refund notifications |
| `POST /api/webhooks/stripe/:webhookPathId` | `Stripe-Signature` (`t`, `v1`) over `t.rawBody` with the organisation's signing secret, 5-minute tolerance; `paymentWebhook` bucket | Stripe settlement and refund notifications |

The random `webhookPathId` only addresses the organisation; it is not a credential. Bodies over 256 KB get 413, unknown addresses 404, and failed verification an empty 400. Verified captures confirm the order whose checkout attempt the provider echoes back; expired or cancelled pages close their attempt; refund events settle pending refunds. Verified events are recorded once per organisation, provider and event id (`ProcessedWebhookEvent`, kept 90 days) and replays get 200. These routes live on the backend API host: in the split layout providers must point at `BACKEND_ORIGIN`, because the website's proxy refuses `/api/webhooks/*`.

Self-hosted installations send email from the worker and run timed jobs from the beat (see `SWE_PROCESS_ROLE`). The outbox endpoint remains for cron services, such as the Cloudflare Worker on free hosting, and for manual recovery. Protected operational endpoints return a generic not-found response when authorization fails.

## Mutation endpoints

Most authenticated dashboard mutations are Next.js Server Actions under `app/actions/`, not conventional REST routes. They still require server-side authentication, role checks, validation, rate limiting, and audit behavior.

Organisation owners manage machine clients at `/dashboard/:orgSlug/settings/api`. This page requires a fresh human authentication before credential, scope, or client-state mutations.
