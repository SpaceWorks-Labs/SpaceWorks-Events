# Netlify frontend with a Docker VPS backend

[Documentation index](README.md) · [VPS installation and operations](DEPLOYMENT_VPS.md)

Use this mode to render the UI on Netlify while all authentication persistence,
permissions, business actions, database queries, private files and background jobs
run in Docker on your VPS. It shares the application's UI and server-owned domain
logic with the whole-VPS deployment. Netlify runs Next.js server rendering and
thin action/API proxies, so this is a Next.js deployment rather than a static SPA.

| Host | Services |
| --- | --- |
| Netlify, `events.example.com` | Shared UI, server rendering, browser-origin API proxy, thin Server Action wrappers |
| VPS, `api.events.example.com` | Guarded view/action API, Auth.js persistence, HTTP APIs, the email worker and the beat (timed jobs) |
| VPS private Docker network | TLS PostgreSQL, TLS/password Redis, private Silo S3 storage |
| External operator services | Authenticated SMTP relay, monitoring, encrypted off-server backup/PITR |

The same split also runs entirely on the VPS: the installer's default layout
puts the website in the `spaceworks-events-frontend` container next to the
backend, behind one Caddy (see [Hosting layouts](DEPLOYMENT_VPS.md#hosting-layouts)).
This guide covers the Netlify variant.

The [SpaceWorks reference](https://github.com/SpaceWorks-Labs/SpaceWorks) uses a
Vite frontend and Django API. Events keeps its Next.js UI, sessions and Server
Actions through explicit backend contracts. Both deployments must use the same
reviewed source revision. The backend uses `DEPLOYMENT_MODE=backend`, which hides
its page routes; the peer credential authenticates the frontend service while
ordinary user session, tenant, permission and MFA checks still run on the VPS.

## 1. Domains and VPS setup

Create your Netlify site first to reserve its hostname, or use a custom frontend
domain. Point the **API** DNS A/AAAA records at the VPS; point the **frontend**
domain at Netlify using its domain setup. Allow inbound VPS TCP 80/443 and optional
UDP 443; keep all data/service ports private. Caddy obtains the API HTTPS
certificate. Use DNS-only API records initially so Caddy sees the real client IP.

Run the [curl installer](DEPLOYMENT_VPS.md#guided-installation), or run
`sudo bash scripts/setup-vps.sh` from a reviewed checkout.
Choose **3 = website on Netlify, API on this VPS**. Enter the API hostname, distinct
website hostname, admin email and SMTP details. The generated external files are:

- `compose.env`: `PUBLIC_HOST` for Caddy, `PUBLIC_ORIGIN` for the frontend and the immutable image version.
- `app.env`: complete backend configuration; `AUTH_URL` and `NEXT_PUBLIC_BASE_URL` both equal the frontend HTTPS origin.
- `frontend.env`: only frontend settings listed below, mode 0600.
- Other service files, TLS certificates and the backend build action key described in the VPS guide.

The manual equivalent adds the frontend hostname as the last setup argument:

```bash
# /config is the owner-only external configuration mount in the ops container.
node docker/vps/setup.mjs api.events.example.com admin@example.com release-version events.example.com netlify
```

Run that command inside the ops container as in the VPS guide, configure SMTP,
then build/start/check the stack normally. Do not rerun setup against an existing
configuration. Switching an existing instance to split hosting is an operator
migration: preserve all keys/data, add a new gateway key and separate frontend
Server Actions key, change canonical origins, rebuild both targets, and review
OAuth, cookies, DNS, old shared links and redirects before cutover.

## 2. Netlify configuration

Import this same Git repository and deploy the identical revision as the VPS.
Configure **Package directory = `frontend`**, keep **Base directory at the
repository root**, and select `frontend/netlify.toml`. It runs `npm run
build:frontend` from the root and publishes `frontend/.next` with Netlify's Next.js
adapter. Use Node.js 22. Do not use a Vite command, `next export` or a SPA rewrite.

Add the values from the generated `frontend.env` through Netlify's secure
environment UI, for the production **build and functions/runtime** contexts:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_BASE_URL` | Exact frontend HTTPS origin, e.g. `https://events.example.com` |
| `BACKEND_ORIGIN` | Exact API HTTPS origin, e.g. `https://api.events.example.com` |
| `NEXT_PUBLIC_BACKEND_ORIGIN` | Same API origin, used only for direct ticket SSE |
| `FRONTEND_GATEWAY_SECRET` | Generated independent 64-character hex key, identical to the backend |
| `FRONTEND_TRUSTED_IP_HEADER` | `x-nf-client-connection-ip`; Netlify must overwrite this client-IP header |
| `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` | Generated frontend key; keep stable across frontend builds/runtime |

Copy individual values through the secure environment interface; generated files
use Compose quoting, so omit the surrounding quotes when entering a value.
Treat the gateway key as a backend access credential. The frontend needs no
`DATABASE_URL`, `DIRECT_URL`, `AUTH_SECRET`, Redis, SMTP, S3 or MFA encryption secrets.
Never place the gateway key in browser variables, source control or build logs.
Production env values must be available to the frontend proxy as well as functions.
Keep preview deploys isolated from production: use a separate backend/config for
previews, or omit production credentials there. Only the canonical frontend origin
is accepted by the peer; branch preview URLs are not automatically trusted.

The build generates the rendering workspace from shared sources and checks that
its deployment traces exclude persistence clients. Edit root `app/`, `components/`,
`lib/` and templates under `frontend/`; generated frontend trees are ignored.

## 3. Authentication, files and live tickets

Keep Google OAuth callbacks on the **frontend**:
`https://events.example.com/api/auth/callback/google`. Configure the same frontend
origin as the provider's authorized JavaScript origin. Instance-managed Google
credentials stay on the VPS. Browser sign-in and session requests travel through
same-origin `/api/auth/*`; host-only cookies are returned to the frontend host.
The private gateway forwards those cookies to backend guards without sharing the
Auth.js secret with Netlify. MFA and station cookies follow the same rule.

Uploads, controlled image delivery, exports, PDFs and normal APIs use frontend
`/api/*`. Mutating browser calls require the canonical Origin; machine API calls
retain their tenant-bound bearer validation. The proxy blocks the internal outbox,
readiness and private peer routes. The worker and the beat run on the VPS; they
never depend on a Netlify scheduled function.

Ticket state streams connect straight to the API hostname so long-lived SSE does
not occupy a Netlify function. Only ticket status/events routes return CORS for
the exact frontend origin; they expose only the existing rate-limited state
projection. No cross-origin session cookie is required. Ticket polling falls
back through the frontend API proxy. Preserve streaming flushes in Caddy/CDNs.

The Space Works mobile apps call the **API hostname** directly
(`https://api.events.example.com/api/mobile/v1`) with bearer tokens; the
frontend's `/api` proxy is deliberately not opened to cookie-less mobile
traffic. App-link files (`/.well-known/assetlinks.json` and
`/.well-known/apple-app-site-association`) are served by the **website** host,
read `ANDROID_APP_PACKAGE_NAME`, `ANDROID_APP_SHA256_FINGERPRINTS` and
`APPLE_APP_IDS` at runtime, so set them on the **frontend** service (Netlify
environment, `frontend.env` on the VPS, which setup writes empty). Mobile Google
sign-in is verified on the **API** host: `GOOGLE_MOBILE_CLIENT_IDS` (or the list
saved in Super admin → Settings) belongs in the backend's `app.env`. In the
single layout and on Render or Helm one container serves both, so all four go
there. See [Mobile API](MOBILE_API.md).

## 4. Verification and operations

Before accepting registrations, verify public HTTPS on both hosts and run the
VPS checks. Then exercise these flows through the frontend domain:

1. Create and verify an account, sign in/out, password reset, session revocation and MFA, including the emailed code for a new browser and the staff authenticator check on `/verify-mfa`. Confirm cookies are HttpOnly and Secure in HTTPS production.
2. Create an organisation and event, edit settings, upload a cover and badge image, and verify another tenant cannot read or mutate them.
3. Publish a page, RSVP, open/download its ticket and scan it from a staff session. Confirm the attendee sees live check-in without reloading, including after reconnect.
4. Send a real verification/broadcast email; check canonical frontend links, private image delivery and the independent VPS outbox heartbeat.
5. Exercise invitation, feedback/certificate, exports and super-admin navigation; direct private peer/readiness/scheduler paths on the frontend must return 404.
6. Complete the off-server backup and isolated restore drill in the VPS guide.

Run `npm run test:e2e:split` for two actual Next.js production servers with
disposable PostgreSQL/Redis, separate action keys and a frontend process without
backend credentials. Run `npm run test:e2e:vps` for the single-runtime variant. A live Netlify adapter build, real domains/HTTPS, OAuth/SMTP delivery,
production-scale load and VPS host-package installation still need verification
in your hosting accounts. Platform duration/response limits also apply to proxy
uploads and exports; check your plan against the largest expected payloads.

For upgrades, run the VPS updater, then deploy the **same revision** on Netlify.
Keep the gateway credential and both hosts' respective Server Actions keys stable.
The updater preserves configuration and volumes. A hostname change requires
rebuilding public variables, updating both canonical URLs and CORS, OAuth origins,
DNS, monitoring and redirects for old shared URLs. Keep encrypted backups of
backend configuration, data and objects; Netlify is not a data-backup service.

For local split development, prepare with `npm run frontend:prepare`, run the root
app as the backend on port 3000 with `DEPLOYMENT_MODE=backend`, and run `npm run
dev --workspace=frontend` on port 3100. Set matching local frontend `AUTH_URL` /
`NEXT_PUBLIC_BASE_URL`, separate `BACKEND_ORIGIN`, the same gateway key on both,
and `FRONTEND_TRUSTED_IP_HEADER=x-real-ip` only behind a proxy that overwrites it.
Keep production secrets separate. Production requires HTTPS; the existing explicit
CI-only insecure test override is reserved for disposable loopback tests.
