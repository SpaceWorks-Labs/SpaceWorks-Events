# Free-tier cloud deployment

[Documentation index](README.md) · [Configuration](CONFIGURATION.md) · [Production release](PRODUCTION_RELEASE.md)

This guide puts Space Works Events into production on free plans only:

| Piece | Service | Repository file |
| --- | --- | --- |
| Application (Docker) | [Render](https://render.com) web service, free plan | `render.yaml`, `Dockerfile`, `scripts/docker-entrypoint.sh` |
| PostgreSQL | [Supabase](https://supabase.com), free project | `prisma/schema.prisma` (`url` + `directUrl`) |
| Redis | [Upstash](https://upstash.com), free database | — |
| Object storage | [Cloudflare R2](https://developers.cloudflare.com/r2/), private bucket | — |
| Email | [Brevo](https://www.brevo.com) SMTP relay | — |
| Scheduler + DNS | [Cloudflare](https://cloudflare.com) Worker cron and DNS | `deploy/cloudflare-cron/` |

Every connection is TLS: `sslmode=require` to Supabase, `rediss://` to
Upstash, HTTPS to R2, STARTTLS to Brevo. All variable names are listed in
[`.env.production.example`](../.env.production.example), which mirrors this
guide.

Pick **one region** for everything (for example Singapore: Render
`singapore`, Supabase `ap-southeast-1`, Upstash `ap-southeast-1`). Each
request crosses these services several times, so distance adds up.

Keep a password manager entry open while you work and save every value you
create in it. You will paste them into Render once, and Render shows
`sync: false` prompts only when the Blueprint is first created.

## 1. Supabase (PostgreSQL)

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
   Choose a strong database password (save it) and your region.
2. Open the project and click **Connect** in the top bar. Under
   **Connection string → URI**:
   - **Transaction pooler** (port `6543`) is the runtime `DATABASE_URL`.
     Append `?pgbouncer=true&connection_limit=5&sslmode=require`.
   - **Session pooler** (port `5432` on the same `pooler.supabase.com` host)
     is `DIRECT_URL`, used only for migrations. Append `?sslmode=require`.

   ```text
   DATABASE_URL=postgresql://postgres.PROJECT-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&sslmode=require
   DIRECT_URL=postgresql://postgres.PROJECT-REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require
   ```

   Why not the "Direct connection" (`db.PROJECT-REF.supabase.co`)? On the free
   plan it is IPv6-only, and Render has no outbound IPv6. The session pooler
   supports everything `prisma migrate deploy` needs (including advisory
   locks).

   - `pgbouncer=true` is required on port 6543: a transaction pooler cannot
     keep Prisma's prepared statements. The preflight and the app's startup
     check reject a 6543 URL without it.
   - `connection_limit=5` caps Prisma's pool on the single small instance.
     `connection_limit=1` also works but serialises every query, including
     interactive RSVP transactions.
   - URL-encode special characters in the password (`@` → `%40`, `#` →
     `%23`, `/` → `%2F`).
3. Do not run migrations by hand: the container applies them on start (step 7).

## 2. Upstash (Redis)

1. At [console.upstash.com](https://console.upstash.com), create a **Redis**
   database in your region (free plan, TLS enabled by default; leave eviction
   off).
2. On the database page, copy the **TLS** connection string for ioredis
   (`rediss://default:PASSWORD@NAME.upstash.io:6379`). That is `REDIS_URL`.

Redis is used for distributed rate limits (one Lua call per limited request)
and pub/sub for live ticket check-in. Nothing polls Redis, so an idle instance
uses almost no commands. The cron (step 8) calls `/api/internal/outbox` once a
minute, which costs one rate-limit command each time, about 45,000 commands a
month.

## 3. Cloudflare R2 (object storage)

1. In the Cloudflare dashboard open **R2 Object Storage** and create a bucket,
   e.g. `spaceworks-events`. Leave **Public access** disabled and do not attach
   a custom domain: the app serves every image through its own access-checked
   route.
2. **R2 → Manage API tokens → Create API token**: permission
   **Object Read & Write**, **Apply to specific buckets only** → your bucket.
   Copy the **Access Key ID**, **Secret Access Key** and the **S3 endpoint**
   (`https://ACCOUNT-ID.r2.cloudflarestorage.com`; drop any bucket path).

   ```text
   S3_BUCKET=spaceworks-events
   S3_REGION=auto
   S3_ENDPOINT=https://ACCOUNT-ID.r2.cloudflarestorage.com
   S3_ACCESS_KEY_ID=...
   S3_SECRET_ACCESS_KEY=...
   S3_FORCE_PATH_STYLE=1
   ```

## 4. Brevo (email)

1. Create a Brevo account. Under **Senders, Domains & Dedicated IPs →
   Domains**, add your domain and publish the records Brevo shows (a
   `brevo-code` TXT, the DKIM records, and a DMARC TXT such as
   `v=DMARC1; p=none; rua=mailto:dmarc@YOUR-DOMAIN`). If the domain already
   has an SPF record, merge `include:spf.brevo.com` into it rather than adding
   a second one. Wait until Brevo shows the domain as authenticated.
2. **Settings → SMTP & API → SMTP**: note the **SMTP login**
   (`…@smtp-brevo.com`) and **Generate a new SMTP key**.

   ```text
   EMAIL_FROM=Space Works Events <events@YOUR-DOMAIN>
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=2525
   SMTP_SECURE=false
   SMTP_USER=YOUR-LOGIN@smtp-brevo.com
   SMTP_PASSWORD=YOUR-SMTP-KEY
   ```

   **Port 2525, not 587:** Render free web services block outbound traffic to
   ports 25, 465 and 587. Brevo accepts STARTTLS on 2525, and the app requires
   TLS with certificate verification on production SMTP. On a paid Render
   instance or another host, 587 works too.

`EMAIL_FROM` must use the authenticated domain. These environment values are
the bootstrap/fallback; after the first login you can move SMTP into
**Super admin → Settings**, where the key is stored encrypted.

## 5. Generate secrets

Render's Blueprint generates `AUTH_SECRET`, `CRON_SECRET` and
`HEALTHCHECK_SECRET` for you. Generate the two AES keys yourself; each must be
base64 of exactly 32 bytes:

```bash
openssl rand -base64 32   # NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
openssl rand -base64 32   # MFA_ENCRYPTION_KEY (a different value)
```

Store both in your password manager.

- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is used by the build and at runtime.
  Changing it needs a redeploy and invalidates open forms.
- Losing `MFA_ENCRYPTION_KEY` makes every enrolled authenticator, and the
  encrypted SMTP/Google settings, unreadable. Never rotate it casually.

Not using the Blueprint? Generate the other three with
`openssl rand -base64 32` as well.

## 6. Check the configuration locally (optional)

Put the values in an owner-only file outside the repository and run the same
preflight CI runs:

```bash
umask 077 && cp .env.production.example /secure/path/swevents.env   # then edit it
node --env-file=/secure/path/swevents.env scripts/check-production-env.mjs
```

It must print `Production environment preflight passed.`

## 7. Render (application)

1. Push the repository to GitHub (`SpaceWorks-Labs/SpaceWorks-Events`).
2. In Render choose **New → Blueprint**, connect the repository, and select
   the branch to deploy. Render reads [`render.yaml`](../render.yaml): one
   Docker web service, free plan, health check `/api/health`.
3. Fill in every prompted (`sync: false`) value. For the first deploy without
   a custom domain, use `https://spaceworks-events.onrender.com` (your service
   URL) for both `AUTH_URL` and `NEXT_PUBLIC_BASE_URL`. If that subdomain is
   taken, Render adds a suffix: after the service is created, check its real
   URL on the service page, set both values to it, and run **Manual Deploy →
   Clear build cache & deploy** (the base URL is baked in at build time).
4. Click **Apply**. The first build takes about 10 minutes. On start the
   container runs `prisma migrate deploy` against `DIRECT_URL`
   (`MIGRATE_ON_START=1`), then starts the server. If a migration fails, the
   container exits, the deploy fails its health check, and the previous
   version keeps serving. Migrations also run on every wake from sleep (a
   no-op when nothing is pending, a few seconds on the free CPU), and if
   Supabase is paused or unreachable the container cannot start at all.
   Render's free plan has no pre-deploy command, so before deploying a release
   that reserves new organisation addresses (0.11.0 does), run the read-only
   check in the Supabase SQL editor or with
   `node scripts/check-reserved-slugs.mjs` and rename any organisation it
   names ([Reserved organisation addresses](production-operations.md#reserved-organisation-addresses)).

How the Blueprint fits the free plan:

- **Build args.** Render passes every environment variable to `docker build`
  as a build argument. The Dockerfile declares only `NEXT_PUBLIC_BASE_URL` and
  `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, so nothing else enters the build. The
  key exists only in the builder stage's metadata and cache, never in the
  final image. Where BuildKit secrets are available (local Docker, GitHub
  Actions, Compose) the secret mount is used instead; a Render *secret file*
  named `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` works the same way if you prefer.
- **Memory.** `NODE_OPTIONS=--max-old-space-size=384` keeps the heap inside
  the 512 MB instance. It applies only at runtime; the build runs on Render's
  separate build machines.
- **Deploys.** `autoDeployTrigger: checksPass` deploys a commit only after
  its GitHub checks pass, and `buildFilter` skips doc-only commits. Builds
  count against the workspace's monthly build minutes.
- **Changing `NEXT_PUBLIC_BASE_URL`** (for example when adding the custom
  domain) needs **Manual Deploy → Clear build cache & deploy**, because the
  value is compiled into the client bundle. Update `AUTH_URL` to the same
  value at the same time.

## 8. Cloudflare DNS and the cron Worker

### Custom domain

1. Add the domain in Render (**Settings → Custom Domains**), e.g.
   `events.YOUR-DOMAIN`.
2. In Cloudflare DNS add `CNAME events → spaceworks-events.onrender.com`
   with **Proxy status: DNS only**, and remove any `AAAA` record for that
   name (Render has no IPv6). Set **SSL/TLS → Overview** to **Full**.
3. Wait for Render to show the certificate as issued. Then set `AUTH_URL` and
   `NEXT_PUBLIC_BASE_URL` to `https://events.YOUR-DOMAIN` and redeploy with a
   cleared build cache.
4. Optional: switch the record to **Proxied** (orange cloud) for Cloudflare's
   WAF/CDN. Then:
   - set `TRUSTED_PROXY_IP_HEADER=cf-connecting-ip` (Cloudflare overwrites
     it). With DNS only, keep `x-forwarded-for`.
   - turn off **Scrape Shield → Email Address Obfuscation** for the hostname
     (it injects a script the CSP blocks).
   - the `onrender.com` URL stays reachable and bypasses Cloudflare. Rate
     limits stay in force there; they just key on the forwarded header.

### Scheduler Worker

The free Render instance runs everything in one process
(`SWE_PROCESS_ROLE=all`). It sleeps after 15 minutes without traffic, which
also stops its email worker and timed jobs. The Worker in
[`deploy/cloudflare-cron`](../deploy/cloudflare-cron/README.md) runs every
minute, wakes the app through `/api/health`, then calls
`POST /api/internal/outbox` with `Authorization: Bearer $CRON_SECRET`.

```bash
cd deploy/cloudflare-cron
npm ci
npx wrangler login
npx wrangler secret put APP_URL       # https://events.YOUR-DOMAIN (no trailing slash)
npx wrangler secret put CRON_SECRET   # copy the value from Render → Environment
npx wrangler deploy
npx wrangler tail                     # expect "health 200" and "outbox 200" each minute
```

`outbox 404` means the Worker's `CRON_SECRET` does not match the app's.

## 9. First super-admin login

1. Set the super-admin password from your computer, with the database's
   direct connection string (Supabase → Connect → Session pooler):
   `DATABASE_URL="postgresql://..." NEXT_PUBLIC_BASE_URL=https://events.YOUR-DOMAIN node docker/vps/recover-super-admin.mjs you@example.com`
   from a checkout of this repository after `npm ci`. It creates the account
   and prints a one-hour link to set its password; run it again to reset the
   password. The super-admin address can't sign up, use forgot password or
   change its password in the app.
2. Sign in with the email and password. We recommend you then open
   `/account/security` and enrol an authenticator app, which is then asked for
   at every sign-in. Save the recovery codes.
3. Open `/super-admin` (there is no separate step-up) and review
   **Settings**: send a test email, and optionally configure Google SSO
   (callback `https://events.YOUR-DOMAIN/api/auth/callback/google`).

## 10. Verify

```bash
curl -fsS https://events.YOUR-DOMAIN/api/health
curl -fsS -H "Authorization: Bearer $HEALTHCHECK_SECRET" https://events.YOUR-DOMAIN/api/health/db
```

Both should return `{"ok":true,…}`. A `404` from `/api/health/db` means the
bearer value is wrong. Then create a test event, register for it, and check
that the ticket email arrives, the cover image uploads (R2), and checking the
ticket in updates the attendee's open ticket page live (Upstash pub/sub).

## Free-tier limits to know

Quotas change, so check each provider's pricing page.

| Service | Limit that matters | What it means here |
| --- | --- | --- |
| Render free | 512 MB RAM, 0.1 CPU; sleeps after 15 idle minutes; 750 instance hours per workspace per month; outbound SMTP 25/465/587 blocked; no pre-deploy command, shell or disk | Cold starts take about 30–60 s. The per-minute Worker keeps the instance awake (about 744 h a month), which uses nearly the whole allowance: run only this one free service in the workspace. CPU is slow for PDF and image work; upgrade the instance for real events. |
| Supabase free | 500 MB database; paused after 7 days without activity; two free projects; no downloadable backups | The per-minute outbox run queries the database, which keeps the project active. If it is ever paused, restore it from the dashboard. Take your own backups (below). |
| Upstash free | Monthly command budget and 256 MB data | Rate limits and check-in pub/sub only; about 45,000 commands a month go to the cron. |
| Cloudflare R2 free | 10 GB storage plus monthly Class A/B operation allowances; no egress fees | Cover images, logos and certificate art are small WebP files. |
| Brevo free | 300 emails per day | Broadcasts to large events will queue for days. Upgrade before a big send. |
| Cloudflare Workers free | 100,000 requests per day | The cron uses about 1,440 runs a day. |

## Backups

Supabase's free plan has no downloadable backups. From a trusted machine with
PostgreSQL client tools at least as new as the Supabase server, take one
regularly through the session pooler:

```bash
DATABASE_URL="$DIRECT_URL" npm run db:backup
```

Copy the archive to a second private bucket with the `--s3-*` options
described in [Production operations](production-operations.md#backup-and-incident-minimums).
