# Configuration

[Documentation index](README.md)

Copy `.env.example` to `.env` for local development. For the default free-tier production stack (Render, Supabase, Upstash, Cloudflare R2, Brevo), start from `.env.production.example` and follow [Free-tier cloud deployment](DEPLOYMENT_CLOUD.md). Production secrets must come from a secrets manager or the deployment platform, never from a committed file.

Blank values (for example `SMTP_HOST=""` left over from `.env.example`) are treated as unset by the production startup check and by `npm run production:check`, so placeholders for panel-managed settings do not stop the server from starting.

## Core and authentication

| Variable | Production | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | Runtime PostgreSQL URL; production requires `sslmode=require`, `verify-ca`, or `verify-full`. Through a transaction pooler (Supabase Supavisor on port 6543) it must include `pgbouncer=true`; add `connection_limit=5` to cap Prisma's pool |
| `DIRECT_URL` | Required with a pooler | Direct or session-mode PostgreSQL URL used only by `prisma migrate` (schema `directUrl`); TLS required when set. Prisma needs the variable to exist, so `npm run db:*`, the migrator image and the container entrypoint fall back to `DATABASE_URL` when it is unset. Local `.env` files should set it to the same value as `DATABASE_URL` for direct `npx prisma` commands |
| `MIGRATE_ON_START` | Optional | `1` makes the Docker runner apply migrations before starting (`scripts/docker-entrypoint.sh`). For platforms without a release job, such as Render free; leave unset where the migrator image or Helm Job runs |
| `NODE_OPTIONS` | Optional | Set `--max-old-space-size=384` on a 512 MB instance (Render free) so the heap stays within memory |
| `AUTH_SECRET` | Required | Auth.js signing/encryption secret, at least 32 characters |
| `AUTH_URL` | Required | Canonical Auth.js HTTPS origin |
| `NEXT_PUBLIC_BASE_URL` | Required | Public link origin; must exactly match `AUTH_URL`. Sent emails also use it to make site-relative images and links (event cover, organisation logo, event page) absolute; without it those are left out of delivered broadcasts, while the dashboard preview still renders them |
| `AUTH_GOOGLE_ID` | Legacy fallback | Google OAuth client ID; configure new instances in Super admin → Settings |
| `AUTH_GOOGLE_SECRET` | Legacy fallback | Google OAuth client secret; configure new instances in Super admin → Settings |
| `ANDROID_APP_PACKAGE_NAME` | Optional, **website** container | Android application id published in `/.well-known/assetlinks.json` (default `in.spaceworks.events`). Read at runtime; nothing is compiled into the images |
| `ANDROID_APP_SHA256_FINGERPRINTS` | Optional, **website** container | Comma-separated SHA-256 signing-certificate fingerprints (`AA:BB:…`) for Android App Links; unset serves `[]` |
| `APPLE_APP_IDS` | Optional, **website** container | Comma-separated `TEAMID.bundle.id` values for iOS Universal Links (`/.well-known/apple-app-site-association`); unset serves empty details |
| `GOOGLE_MOBILE_CLIENT_IDS` | Fallback, **API** (backend) container | Comma-separated Google OAuth client IDs of the Space Works Android and iOS apps, accepted by the mobile API's Google sign-in; a list saved in Super admin → Settings overrides it. Public identifiers, not secrets |
| `SUPER_ADMIN_EMAIL` | Recommended | Sole email allowed into the instance administration area. Its password is set only from the server (`scripts/vps-recover.sh` or `docker/vps/recover-super-admin.mjs`): the app refuses its sign-up, never emails it a reset link and hides its password form |
| `STAFF_MFA_REQUIRED` | Optional | On unless set to `false`. Organisation staff (any membership or co-organiser grant) must set up an authenticator app and confirm it each session. `false` is for local development and tests only |
| `LOGIN_NEW_DEVICE_CHECK` | Optional | On unless set to `false`. A password sign-in from a device the account hasn't used before needs a code emailed to the account. `false` is for tests only |
| `PWNED_PASSWORDS_CHECK` | Optional | On unless set to `false`. New passwords are refused when found in Have I Been Pwned (k-anonymity; needs outbound HTTPS to `api.pwnedpasswords.com`). `false` for air-gapped installs and tests |

### Deployment example

Configure both canonical URL settings to the exact same HTTPS origin, for example a custom domain or, before you have one, the Render service URL:

```env
AUTH_URL=https://events.example.com
NEXT_PUBLIC_BASE_URL=https://events.example.com
# or, temporarily: https://spaceworks-events.onrender.com for both
```

If Google OAuth is enabled, register the matching callback with Google Cloud:

```text
https://events.example.com/api/auth/callback/google
```

Leave `ALLOWED_ACTION_ORIGINS` empty when browsers reach the application on this same hostname (including `*.onrender.com`). Configure it only if a trusted CDN or reverse proxy uses a different host for Server Action requests; no platform hostname is hard-coded. It is read when the image is **built**, so it needs your own build; the published release images refuse to start with it set (see [Releases and container images](CONTAINER_IMAGES.md)).

### Changing the public domain

When the application moves to a new hostname, update `AUTH_URL` and `NEXT_PUBLIC_BASE_URL`, update the Google OAuth callback/origin if used, then rebuild and deploy because `NEXT_PUBLIC_BASE_URL` is build-visible. Update DNS, TLS, the CDN/WAF, scheduler and uptime-monitor targets, and any reverse-proxy host allowlists at the same time.

Keep an HTTPS redirect from the old hostname to the new one for as long as invitation, ticket, certificate, and shared event links may be used. Auth cookies are host-specific, so existing users may need to sign in again after the change.

## Application secrets

| Variable | Production | Purpose |
| --- | --- | --- |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Required | Stable base64 AES key shared by the build and every replica; 16, 24, or 32 decoded bytes |
| `MFA_ENCRYPTION_KEY` | Required | Independent base64 key used to encrypt TOTP seeds; exactly 32 decoded bytes. A domain-separated subkey also encrypts the SMTP password, Google client secret, and alert webhook URL saved in Super admin → Settings, and others the organisation webhook signing secrets and organisations' own secrets. Two more subkeys are HMAC keys, not encryption: the mobile API's `Idempotency-Key` and request-body digests, and the signature on payment return links. Must be identical on every replica and job (app pods, migration job, any one-off container) and stable |
| `CRON_SECRET` | Required | Bearer secret for `POST /api/internal/outbox` (one full pass of timed jobs and email delivery, for cron services and recovery), at least 32 characters |
| `SWE_PROCESS_ROLE` | Optional | `all` (default): serve requests, send email (worker) and run timed jobs (beat) in one process. `web`, `worker` or `beat`: one part only, for installs that run them as separate containers. The image's `worker` and `beat` commands set it |
| `OUTBOX_POLL_MS` | Optional | How often the worker checks for queued email, in milliseconds (default 3000, 500 to 60000) |
| `HEALTHCHECK_SECRET` | Required | Bearer secret for database readiness, at least 32 characters |

Generate independent keys with `openssl rand -base64 32`. Rotating the Server Action key invalidates outstanding action forms. Rotating the MFA key without re-encrypting stored seeds prevents enrolled users from validating TOTP codes.

**`MFA_ENCRYPTION_KEY` mismatch or rotation.** The server validates only the key's format at startup, so a replica with a different key still starts and passes health checks — it does not crash-loop — but on that replica every use of a value encrypted with the original key fails: outbox delivery fails and is retried until the outbox gives up, Google sign-in fails, alerts are not sent, and TOTP verification fails. The two HMAC subkeys fail silently instead: a mobile write retried onto a replica with another key no longer matches its `Idempotency-Key` record, so it runs a second time (or is refused as a conflict) instead of replaying the first answer, and a buyer coming back from Razorpay or Stripe through a return link signed on another replica gets a 404 instead of the order page (the payment itself still settles through the provider webhook). Rotating the key has the same effect once: return links and idempotency records from before the rotation stop matching (both expire within a day). Behind a load balancer this looks intermittent. Detect it with the same environment the application receives:

```bash
node --env-file=/secure/path/swevents.env scripts/check-instance-secrets.mjs
```

It checks the panel's SMTP password, Google client secret and alert webhook, enrolled authenticator seeds, and every organisation's mail server password, chat channel credentials, payment keys and check-in station PINs. It reports how many of each cannot be decrypted, never printing values or identifiers, and exits non-zero (it is also included in the `migrator` image and can run in the Helm migration job with `migration.checkInstanceSecrets=true`). Fix it by restoring the original key on every replica and job. If the original key is lost, set one new key everywhere, re-enter the SMTP password, Google client secret, and alert webhook in Super admin → Settings, and have enrolled users re-enrol MFA (recovery codes are hashed, not encrypted, and still work).

## Redis and request trust

| Variable | Production | Purpose |
| --- | --- | --- |
| `REDIS_URL` | Required | Distributed rate limiter and pub/sub for live ticket check-in across replicas; production requires `rediss://` |
| `TRUSTED_PROXY_IP_HEADER` | Required | One of `cf-connecting-ip`, `x-forwarded-for`, or `x-real-ip`; the edge must overwrite it. Render reached directly: `x-forwarded-for`; behind your own proxied Cloudflare zone: `cf-connecting-ip` |
| `TRUSTED_PROXY_HOPS` | Optional | With `x-forwarded-for` only: the number of trusted proxies that append to the header. Unset means the edge overwrites it and the left-most entry is used. Render: `1` (the right-most entry, added by Render's proxy) |
| `ALLOWED_ACTION_ORIGINS` | Optional | Comma-separated trusted proxy/CDN hosts allowed to invoke Server Actions |
| `ALLOWED_EMBED_ORIGINS` | Optional | Exact HTTPS origins permitted to frame public event embeds; blank disables cross-site framing |
| `NEXT_DEV_ALLOWED_ORIGINS` | Development only | Comma-separated LAN hosts permitted to request development assets |

Do not expose the application directly while trusting a client-controlled forwarding header.

Rate-limit windows are defined in code (`lib/rateLimit.ts`), not configured by environment. Recent buckets: `dataExport` (5 personal data exports per user per hour), `broadcastDraft` (60 email draft saves or discards per minute, per user and per IP), `ticketStatus` (120 ticket status reads per IP per minute), `ticketEvents` (60 ticket event-stream connections per IP per minute), `shortLink` (30 short-link lookups per IP per minute), `loginFailureIp` (20 failed sign-ins per address per hour, then that address is blocked), `loginFailureAccount` (5 failed sign-ins per account in 15 minutes, then an emailed code is needed), and `loginCode` (5 sign-in codes emailed per account per hour). Without a trusted proxy header every client reads as "unknown", and "unknown" is never blocked. The ticket buckets are generous because attendees at one venue often share a NAT address. Organisation webhooks add `webhookManage` (30 webhook endpoint changes per minute) and `webhookTest` (20 webhook test sends or redeliveries per hour).

The live ticket stream at `/api/ticket/:token/events` is a long-lived `text/event-stream` response. Any reverse proxy in front of the application must not buffer it (for nginx, `proxy_buffering off`; the route also sends `X-Accel-Buffering: no`) and must allow idle reads of at least 30 seconds.

## Email and retention

| Variable | Production | Purpose |
| --- | --- | --- |
| `EMAIL_FROM` | Optional fallback | Verified sender identity; configure new instances in Super admin → Settings |
| `SMTP_*` | Optional fallback | SMTP settings; configure new instances in Super admin → Settings. When `SMTP_SERVICE`/`SMTP_HOST` is set without `SMTP_ALLOW_UNAUTHENTICATED=1`, `production:check` requires `SMTP_USER` and `SMTP_PASSWORD` |
| `OUTBOX_RETENTION_DAYS` | Optional | Retention for non-capability sent/failed outbox history; defaults to 30 (capability-bearing rows are deleted immediately after delivery or terminal failure) |

Configure SMTP, Google SSO, paid events, backup status, and operational alerts under **Super admin → Settings**. SMTP and Google client secrets and the alert webhook URL are encrypted at rest with a domain-separated key derived from `MFA_ENCRYPTION_KEY`, are never displayed after saving, and can be changed only by the super admin. Production SMTP connections require TLS with certificate verification: implicit TLS (`SMTP_SECURE=true`, usually port 465) or STARTTLS (`SMTP_SECURE=false`, port 587 or 2525). Render free web services block outbound ports 25, 465 and 587, so use Brevo on port 2525 there.

### Panel settings and environment fallbacks

- **Database overrides environment.** Panel values are read from the database at send and sign-in time on every replica, so a change applies on the next email or sign-in without a restart, redeploy, or rebuild. None of them is build-visible.
- **SMTP is all-or-nothing.** Once SMTP (a service or a host) is saved in the panel, every `SMTP_*` variable is ignored: service, host, port, TLS, username, password, and the private-relay flag all come from the panel, and no single field falls back to the environment. Clear both Service and Host and save to return to the environment configuration. The sender address falls back on its own: the saved value, then `EMAIL_FROM`, then `Space Works Events <noreply@localhost>`. **Send test email** on the Settings page sends straight to your own super-admin address with the saved settings (15-second limit) and names the SMTP error; the one on Operations goes through the outbox. Organisations that use their own server (Organisation settings → Email) are not affected by these settings. In production, SMTP must be authenticated unless *Private unauthenticated relay* (or `SMTP_ALLOW_UNAUTHENTICATED=1`) is set; TLS 1.2+ with certificate verification is required except in CI/staging mode (`CI=true` with `ALLOW_INSECURE_PRODUCTION_TESTS=1`, e.g. Mailpit on port 1025).
- **Google SSO** uses a saved client ID only with the saved secret. If that secret is missing or cannot be decrypted, Google sign-in is off rather than paired with an environment secret, and password sign-in keeps working. With no saved client ID, `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` (or the legacy `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) apply, and the panel cannot switch those off; remove the variables instead. Register `${AUTH_URL}/api/auth/callback/google` with Google.
- **Backup posture:** any saved backup field replaces the `BACKUP_*` values together; the last successful backup is entered in UTC.
- **Not required in the environment.** Neither the startup check nor `npm run production:check` requires `EMAIL_FROM`, `SMTP_*`, or `AUTH_GOOGLE_*`; the preflight only notes when no SMTP fallback exists. Until SMTP is saved in the panel (or provided as a fallback), production email stays queued. Keeping an environment SMTP fallback is still recommended for bootstrap and disaster recovery (for example, a lost `MFA_ENCRYPTION_KEY`).
- **Operational alerts** are configured only in the panel. Every application process posts them directly to the webhook (for example Mattermost) over outbound HTTPS, so app containers/pods need egress to the webhook host on port 443, in addition to SMTP (typically 465/587), PostgreSQL, Redis, and object storage. Browser crash reports reach the app at `/api/client-errors` and are forwarded the same way. The webhook host must resolve only to public addresses, checked when it is saved and before every post (including **Send test message**), and each post connects only to the addresses just checked, so it cannot be used to probe this host, its network or cloud metadata. Set `OPS_WEBHOOK_ALLOW_PRIVATE=1` to allow a chat server on a private network. Ordinary sign-in outcomes (a wrong password, the authenticator or new-device code step, an unverified email, too many attempts, a missing CSRF token, a declined or expired sign-in) are not alerts; provider and configuration failures still raise "Sign-in failed (…)" (`lib/authLogger.ts`).

## Object storage

| Variable | Production | Purpose |
| --- | --- | --- |
| `S3_BUCKET` | Required | Private object-store bucket |
| `S3_REGION` | Required | Bucket region; `auto` for Cloudflare R2 |
| `S3_ENDPOINT` | Provider-dependent | Custom HTTPS endpoint for R2, Silo, or another compatible service |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | Provider-dependent | Configure both, or neither when using a workload/IAM role |
| `S3_FORCE_PATH_STYLE` | Optional | Set to `1` for providers that require path-style addressing (`1` for Cloudflare R2 and Silo) |

The bucket must remain private. Existing database-backed assets can be moved with `npm run storage:migrate` after S3 is configured.

## Operational metadata

| Variable | Purpose |
| --- | --- |
| `BACKUP_*` | Legacy fallback | Backup status metadata; configure new instances in Super admin → Settings |

## Organisation webhooks

| Variable | Production | Purpose |
| --- | --- | --- |
| `WEBHOOKS_ALLOW_PRIVATE_TARGETS` | **Never** (development/test only) | `1` lets organisation webhooks use `http://` and private or loopback receivers on any port, for a local test receiver. A production server ignores it except in the CI-only test mode below, and `npm run production:check` fails when it is set |

Webhook signing secrets are encrypted with a domain-separated key derived from `MFA_ENCRYPTION_KEY`; no new secret is needed. App processes need outbound HTTPS (ports 443 and 8443) to the receivers organisations configure. See [Organisation webhooks](WEBHOOKS.md).

## Test-only bypass

`PAYMENTS_FAKE_PROVIDER_URL` points every Razorpay and Stripe API call at a local fake provider for tests (a loopback `http://127.0.0.1:<port>` origin only). It is refused when `NODE_ENV=production`: startup validation fails and provider calls throw. Organisations' payment keys are not environment variables; owners enter them in Settings → Payments, encrypted with a subkey of `MFA_ENCRYPTION_KEY`.

`ALLOW_INSECURE_PRODUCTION_TESTS=1` has an effect only when `CI=true`. Together they permit local HTTP, non-TLS test services, the controlled in-memory Redis fallback, and `WEBHOOKS_ALLOW_PRIVATE_TARGETS` while exercising a production build. Never configure this pair in a deployed environment.

Validate production configuration with:

```bash
npm run production:check
```


## Separate Netlify frontend and VPS backend

See [split deployment](DEPLOYMENT_SPLIT.md). Set `DEPLOYMENT_MODE=backend` and a
32-byte hex `FRONTEND_GATEWAY_SECRET` only when enabling the backend peer.
`AUTH_URL` and `NEXT_PUBLIC_BASE_URL` remain the same frontend HTTPS origin.
The frontend receives `BACKEND_ORIGIN`, `NEXT_PUBLIC_BACKEND_ORIGIN`,
`FRONTEND_GATEWAY_SECRET`, `FRONTEND_TRUSTED_IP_HEADER` and its own stable
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, plus `NEXT_PUBLIC_BASE_URL`. The gateway key
is server-only; never prefix it with `NEXT_PUBLIC_`. Use the Netlify-provided
`x-nf-client-connection-ip` header or a directly controlled reverse proxy that
always overwrites `x-real-ip`. Unknown addresses share the fail-closed fallback
bucket; forwarded browser-chosen headers are never authoritative.
