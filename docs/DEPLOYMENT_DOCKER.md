# Production Docker deployment

[Documentation index](README.md)

This guide describes the Docker deployment that the repository supports today.
It is intended for a single host or another container platform that does not use
Kubernetes. For Kubernetes, use the [Helm chart](../charts/spaceworks-events/README.md).
For the default free-tier setup (Render, Supabase, Upstash, Cloudflare R2,
Brevo), follow [Free-tier cloud deployment](DEPLOYMENT_CLOUD.md) instead.

For the complete single-VPS stack, use **[Host the complete stack on a VPS](DEPLOYMENT_VPS.md)**
and `compose.production.yml`. It includes PostgreSQL, Redis, private storage,
HTTPS, migrations and scheduling. This page covers the alternative: an application
container with separately supplied production services. The root
`docker-compose.yml` remains development-only; `compose.staging.yml` deliberately
enables insecure test exceptions. Neither is a production setup.

## Production topology

Run the Space Works Events application container behind a TLS-terminating reverse proxy or
load balancer. Supply these production services separately:

- PostgreSQL with TLS, encryption at rest, point-in-time recovery, and tested
  backups;
- Redis over TLS (`rediss://`);
- private S3-compatible object storage, using an HTTPS endpoint when one is
  configured;
- authenticated transactional SMTP; and
- a CDN/WAF or reverse proxy that overwrites the configured trusted client-IP
  header.

The application container needs outbound network access to all of these, and
to the operational alert webhook (for example Mattermost) over HTTPS when
alerts are enabled in Super admin → Settings. Every application process,
including separate `worker` and `beat` containers, posts alerts itself. Docker's default bridge network allows this egress;
check any host firewall or egress proxy.

The live ticket page holds a Server-Sent Events stream at
`/api/ticket/:token/events`. Configure the reverse proxy not to buffer
`text/event-stream` responses (nginx: `proxy_buffering off` for
`/api/ticket/`; the route also sends `X-Accel-Buffering: no`) and to allow idle
reads of at least 30 seconds. Redis pub/sub carries check-in notifications
between application replicas.

The application image contains only the application. It does not run
PostgreSQL, Redis, object storage, TLS termination, or SMTP. Keep the container
port private and expose it only through the trusted proxy.

## Build immutable images

Every green build of `main` publishes public images to GitHub Packages that
work for any installation (see [Releases and container images](CONTAINER_IMAGES.md)):
pull `ghcr.io/spaceworks-labs/spaceworks-events-backend:<version>` and skip this
section. The same image runs the application and, with the command `migrate`,
the one-shot migrations. The commands below build your own image instead.

```bash
export SWE_VERSION=1.0.0

docker build \
  --target runner \
  --secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY --build-arg NEXT_PUBLIC_BASE_URL="$NEXT_PUBLIC_BASE_URL" \
  --tag ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION} \
  .
```

Export `NEXT_PUBLIC_BASE_URL` with the production HTTPS origin before building;
it is compiled into the image and must match the runtime canonical URL. (Build
with `https://spaceworks-events-origin.invalid` instead for an image that takes
its origin at start, like the published one.) It is the only build-visible
setting: SMTP, Google SSO, backup posture, and alerts
saved in Super admin → Settings are read from the database at runtime and never
require a rebuild or restart.

The Server Actions key is passed through a BuildKit secret mount and is required
only by the application build. (Builders without BuildKit secrets, such as
Render, may pass it as a `--build-arg` of the same name instead; the value
then stays in the builder stage's metadata and cache but never reaches the
runner image.) Supply the
same stable value to the running application. Build it in trusted CI without
printing it, and do not publish or reuse the key between independent Space Works Events
instances. Rotating it invalidates outstanding Server Action forms.

Push immutable version tags to a private registry. Do not deploy a mutable
`latest` tag.

## Configure the runtime

Create a production environment file outside the repository, restrict it to its
owner, and populate the variables documented in
[Configuration](CONFIGURATION.md). A deployment-platform secrets manager is
preferred; an owner-only environment file is the minimum single-host option.

```bash
umask 077
touch /secure/path/swevents.env
```

At minimum, verify that:

- `AUTH_URL` and `NEXT_PUBLIC_BASE_URL` are the same public HTTPS origin;
- `DATABASE_URL` (and `DIRECT_URL`, when set) requires TLS;
- `REDIS_URL` starts with `rediss://`;
- a custom `S3_ENDPOINT`, when used, starts with `https://`;
- the S3 bucket is private;
- `MFA_ENCRYPTION_KEY` is set, stable, and identical for the application and
  every migrator or one-off container: it decrypts the SMTP, Google, and alert
  secrets saved in the panel, so reuse the existing value on upgrades;
- optionally, `EMAIL_FROM` and an authenticated `SMTP_SERVICE` or `SMTP_HOST`
  fallback for bootstrap and disaster recovery (once SMTP is saved in the
  panel these variables are ignored entirely);
- `TRUSTED_PROXY_IP_HEADER` names a header overwritten by the edge; and
- `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is this installation's stable key (for
  your own build, the value it was built with; published images take it at
  runtime).

Run the preflight from a trusted release checkout before deploying:

```bash
node --env-file=/secure/path/swevents.env scripts/check-production-env.mjs
```

Do not expose the contents of the environment file in logs, shell tracing, or a
deployment record.

## First installation

For a new empty database, run the image's one-shot `migrate` role before
starting the application:

```bash
docker pull ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION}

docker run --rm \
  --env-file /secure/path/swevents.env \
  ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION} migrate

node --env-file=/secure/path/swevents.env scripts/verify-production-schema.mjs
node --env-file=/secure/path/swevents.env scripts/check-instance-secrets.mjs
```

The backend image includes `scripts/verify-production-schema.mjs` and
`scripts/check-instance-secrets.mjs`, so both can also run inside it with
exactly the application's environment file.

Start the application on a loopback-only port when the reverse proxy runs on
the host:

```bash
docker run -d \
  --name swevents \
  --restart unless-stopped \
  --env-file /secure/path/swevents.env \
  --publish 127.0.0.1:3000:3000 \
  ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION}
```

If the proxy is another container, use a private Docker network instead of a
published host port. Do not publish PostgreSQL, Redis, or object-storage
administration ports to the internet.

Verify liveness locally and through the public HTTPS origin:

```bash
curl --fail http://127.0.0.1:3000/api/health
curl --fail https://events.example.com/api/health
```

Also call `GET /api/health/db` from the monitoring system with the
`Authorization` header set to `Bearer $HEALTHCHECK_SECRET`. Do not place that
bearer value in a URL.

Set the super-admin password from the server with
`docker/vps/recover-super-admin.mjs` (the app refuses that address's sign-up
and password reset). After the first sign-in, we recommend enrolling
authenticator MFA for the super-admin account; there is no separate step-up for
`/super-admin`. Then configure SMTP (replacing any environment fallback),
optional Google SSO, and optional operational alerts under
`/super-admin/settings`. Saved values take effect on the next send or sign-in;
no restart is needed. Test email delivery before accepting registrations.
Keeping environment SMTP credentials in the deployment secret store as a
disaster-recovery fallback is recommended; they apply only while the panel has
no SMTP configured.

## Upgrade an existing installation

Use this order for every release:

1. Complete the [production release checklist](PRODUCTION_RELEASE.md).
2. Take and verify a database backup and record the current application image.
3. Pull the new backend image.
4. Run it once with the command `migrate`. A failed migration blocks the rollout.
   Then run `node scripts/check-instance-secrets.mjs` in the same image and
   environment; it fails if `MFA_ENCRYPTION_KEY` cannot decrypt the settings
   saved in the panel (see
   [Configuration](CONFIGURATION.md#application-secrets)).
5. Replace the application container with the new immutable image.
6. Verify liveness, authenticated database readiness, outbox heartbeat, email
   delivery, Redis health, and error rate before completing the deployment.

Example container replacement after a successful migration:

```bash
docker stop swevents
docker rename swevents swevents-previous

docker run -d \
  --name swevents \
  --restart unless-stopped \
  --env-file /secure/path/swevents.env \
  --publish 127.0.0.1:3000:3000 \
  ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION}
```

Remove `swevents-previous` only after the new release is healthy. Reverting the
application image does not reverse a database migration; migrations must be
reviewed for backward compatibility and restored from a verified backup when a
database rollback is genuinely required.

## Email worker, timed jobs and readiness

By default (`SWE_PROCESS_ROLE=all`) the application container also sends queued
email within seconds (the worker) and runs the timed jobs: payment holds and
reminders, waitlists, event reminders, retention and backup alerts (the beat). To run them separately, set
`SWE_PROCESS_ROLE=web` on the application container and start two more
containers from the same image with the commands `worker` and `beat`. They
listen on loopback only and need no published port:

```bash
docker run -d --name swevents-worker --restart unless-stopped \
  --env-file /secure/path/swevents.env \
  ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION} worker
docker run -d --name swevents-beat --restart unless-stopped \
  --env-file /secure/path/swevents.env \
  ghcr.io/spaceworks-labs/spaceworks-events-backend:${SWE_VERSION} beat
```

Replace them with the application container on every upgrade. Monitor the
worker and beat heartbeats and failed queue items under Super admin →
Operations. `POST /api/internal/outbox` with `Authorization: Bearer
$CRON_SECRET` runs every timed job once and then sends the queue; use it for
manual recovery or from a cron service on a platform that cannot run the
background roles.

Use `/api/health` for dependency-free liveness. Use the bearer-protected
`/api/health/db` endpoint for readiness. Never expose either bearer secret in
monitoring URLs or logs.

## Migrating on start (platforms without a release job)

The `runner` image bundles a pinned Prisma CLI and the migrations. With
`MIGRATE_ON_START=1`, its entrypoint (`scripts/docker-entrypoint.sh`) runs
`prisma migrate deploy` before starting the server and exits non-zero if a
migration fails. Use this only where no separate release step exists (the
Render free plan); with several replicas, keep the separate `migrate` step so
one release applies migrations exactly once.

Migrations connect through `DIRECT_URL` and fall back to `DATABASE_URL`. Set
`DIRECT_URL` to a direct or session-mode connection whenever `DATABASE_URL`
goes through a transaction pooler (for example Supabase on port 6543 with
`pgbouncer=true`). This applies to the `migrate` role as well.

## Current image-packaging limitations

The `runner` image also carries the [VPS](DEPLOYMENT_VPS.md) operator tools
(`docker/vps/*.mjs`: setup, preflight, schema checks and smoke tests), which the
VPS stack runs as its `ops` service, and the Prisma CLI for its `migrate` role.
The `db-backup`, `db-restore` and storage-migration scripts are copied in too,
but cannot run there: the image has no PostgreSQL client tools and not all of
their dependencies. (The VPS stack backs up through its PostgreSQL container
instead.) Consequently:

- run `npm run storage:migrate` from a trusted checkout when legacy
  database-backed assets still exist; and
- run `npm run db:backup` and `npm run db:restore` from a trusted operational
  host with compatible PostgreSQL client tools.

Follow [Production operations](production-operations.md) for backup storage,
restore acknowledgement, retention, monitoring, and incident requirements.
The [one-line VPS installer](DEPLOYMENT_VPS.md#guided-installation) runs the
latest GitHub Release with its published images, or builds these targets on the
server from a branch or commit (`--ref`); `sudo bash scripts/setup-vps.sh`
builds from a reviewed checkout.
