# Host the complete stack on a VPS

[Documentation index](README.md) · [Docker image details](DEPLOYMENT_DOCKER.md)

Run Space Works Events on one Linux VPS with Docker Engine and Docker Compose.
The production stack uses two images of its own: the **backend** (the API, the
one-shot migrations, the email worker, the beat that runs timed jobs, live
check-in and the operator tools) and the **frontend** (the website). PostgreSQL
16, Redis 7, private Silo S3-compatible storage and Caddy HTTPS run from their
standard images in the same Compose file. Node.js, PostgreSQL and Redis do not
need to be installed on the host.

This follows the service separation used by [SpaceWorks](https://github.com/SpaceWorks-Labs/SpaceWorks),
with the transport and privacy requirements of this Events application. Use
`compose.production.yml` through `scripts/vps-compose.sh`. The root
`docker-compose.yml` is for development and `compose.staging.yml` is for tests.

## Before you start

- A 64-bit (x86_64 or arm64) Linux VPS: Ubuntu/Debian, Fedora/RHEL/Alma/Rocky,
  Arch or openSUSE. The installer installs Docker Engine + Compose when missing.
  Start with **2 vCPU, 2 GB RAM and 30 GB SSD** for a small installation, with
  extra space for uploads and backups. These are starting estimates, not
  load-tested capacity limits. Releases run published images; only a source
  build (`--ref`) compiles on the server, which needs about 4 GB of memory. The
  installer offers a swap file when memory is short.
- A domain, such as `events.example.com`, whose DNS A record points to the VPS.
  Add an AAAA record only if IPv6 reaches this host too. Start with DNS-only
  records; the supplied proxy assumes clients connect directly to Caddy.
- Allow inbound TCP 80 and 443 (plus UDP 443 for HTTP/3) and restrict SSH to
  administrators. Only Caddy publishes application ports (or, behind your own
  reverse proxy, the app listens on `127.0.0.1` only). Do not publish the
  app, database, Redis, storage API or storage console ports.
- An authenticated SMTP relay and a verified sending domain with SPF, DKIM and
  DMARC. Outgoing mail uses this relay; the stack does not operate a public mail
  server. Confirm that the VPS permits outbound SMTP on your relay's TLS port.
- Outbound HTTPS to `api.pwnedpasswords.com`, so new passwords can be checked
  against known breaches. Without it the check quietly lets every password
  through; set `PWNED_PASSWORDS_CHECK=false` on air-gapped hosts.
- Encrypted host disks and an encrypted, off-server backup destination. A single
  VPS is a single failure domain; Docker volumes alone are not backups or
  automatic point-in-time recovery.

## Guided installation

As root or a user with `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/SpaceWorks-Labs/SpaceWorks-Events/main/install.sh | bash
```

The bootstrap checks for Linux, the architecture, root or sudo and `curl`/`tar`,
finds the latest [GitHub Release](CONTAINER_IMAGES.md#versions-and-releases)
(or the one named with `--release v<version>`) and downloads its source into
temporary storage. The release's `scripts/setup-vps.sh` then checks disk space
and the Docker Compose version (2.24.4 or newer, if Docker is already
installed) and asks every question first: the hosting layout (below),
hostnames, super-admin email, HTTPS, file storage, verified sender, SMTP relay
(password hidden; Brevo is prefilled on port 2525), automatic deploys, backups
(nightly schedule, encryption, off-site copies; see
[Backups and recovery](#backups-and-recovery)) and optional
[server hardening](#server-security). It then checks that the ports it needs are
free (80/443 for Caddy; 8080 and 8081 behind an existing proxy).
Invalid answers are asked again. When memory is short it offers a 4 GB swap file.
It reports what the hostname resolves to and shows one summary of every answer
and host change. **Nothing changes before you confirm.**

After confirmation it creates the swap file if accepted, installs Docker from the
distribution family's official source if missing, copies the release to
`/opt/spaceworks-events/releases/<commit>`, generates configuration in
`/etc/spaceworks-events`, downloads the release's images from GitHub Packages,
applies migrations, waits for healthy services and runs the VPS checks.
`current` then points at the release and `/opt/spaceworks-events/install.conf`
records the configuration directory and the repository to update from.

### Hosting layouts

Like SpaceWorks, the stack runs a backend and a frontend image (see
[Releases and container images](CONTAINER_IMAGES.md)), with PostgreSQL, Redis,
Silo storage, one-shot migrations (the backend image's `migrate` role), the
email worker and the beat (its `worker` and `beat` roles) and Caddy:

| Choice | Layout | Containers | DNS |
| --- | --- | --- | --- |
| 1 (default) | `split` | website (`frontend`) and API (`app`, the backend) | two A records to this VPS, e.g. `events.example.com` and `api.events.example.com` (the default API name) |
| 2 | `single` | one `app` container serves the website and the API | one A record |
| 3 | `netlify` | the API here; the website on [Netlify](DEPLOYMENT_SPLIT.md) | the API record here, the website at Netlify |

In `split`, Caddy serves the website hostname from the frontend container and
the API hostname from the backend. The frontend reaches the backend by its HTTPS
name, which Caddy also answers on the private Docker network, so the request
never leaves the server. The website and API need different hostnames: the
gateway between them, and live check-in streamed from the API, depend on two
origins. `compose.env` records the layout (`SWE_LAYOUT`); installations from
before 0.9.1 keep the `single` (or Netlify) layout they were set up with.

### HTTPS

As in SpaceWorks, setup asks how HTTPS reaches the stack:

| Choice | What runs | Notes |
| --- | --- | --- |
| 1 LAN or trial | Caddy with its own local certificate authority | For hostnames that are not publicly reachable. Browsers warn until the CA (`caddy_data` volume: `caddy/pki/authorities/local/root.crt`) is trusted on each device. The website container receives only that public certificate. |
| 2 Automatic HTTPS (default) | Caddy with Let's Encrypt | DNS must point at this server and ports 80/443 must be reachable. An optional certificate email gets expiry notices. |
| 3 Existing reverse proxy | No Caddy | The API listens on `127.0.0.1:8080` and, in the split layout, the website on `127.0.0.1:8081`. Your proxy terminates HTTPS, preserves `Host`, overwrites `X-Real-IP` with the client address, sends `X-Forwarded-Proto: https` and does not buffer responses (live check-in streams). In the split layout the website calls the API's HTTPS name through this server's own proxy. |

Behind an existing proxy, the app trusts `X-Real-IP` for rate limits and audit
records, so the proxy **must overwrite** it with the client address (a proxy
that passes the client's own header through lets anyone spoof their IP). In
the split layout the website reaches the API by its HTTPS name on this server's
Docker bridge address, so the proxy must also listen there (or on all
addresses) with a publicly trusted certificate. Examples:

```nginx
# nginx, for each hostname
location / {
  proxy_pass http://127.0.0.1:8080;   # 8081 for the split layout's website
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-Proto https;
  proxy_buffering off;
}
```

```apache
# Apache (mod_proxy, mod_headers)
ProxyPreserveHost On
RequestHeader set X-Real-IP "%{REMOTE_ADDR}s"
RequestHeader set X-Forwarded-Proto "https"
ProxyPass / http://127.0.0.1:8080/ flushpackets=on
ProxyPassReverse / http://127.0.0.1:8080/
```

Unlike SpaceWorks there is no plain-HTTP mode: Events requires HTTPS origins
and secure cookies in production, so LAN and trial installs use Caddy's own
certificate instead. `compose.env` records the choice (`SWE_CADDY_TLS`:
`internal`, `proxy`, or unset for automatic).

### File storage

Setup also asks where uploads (event covers, ID cards, attachments) live:
bundled **Silo** on this server (default) or an **external S3-compatible bucket**
such as Cloudflare R2 or Amazon S3. For an external bucket, create a private
bucket and an access key limited to it first, then enter the HTTPS endpoint,
region (`auto` for R2), bucket, access key and secret (hidden). The application
reads and writes the bucket itself; browsers never talk to it, so no CORS is
needed. With external storage (`SWE_STORAGE='external'`) the Silo services do
not run and `vps-backup.sh` copies the database and configuration only: back
the bucket up with your provider. Versioning may be on: the app deletes every version
of a deleted file, so on Amazon S3 the key also needs `s3:ListBucketVersions` and
`s3:DeleteObjectVersion`, and no object lock or retention rule may keep deleted versions
([storage contract](CONFIGURATION.md#storage-contract-and-the-deletion-queue)).
To change the bucket later, copy every object to the new bucket first, then edit
`S3_*` in `app.env` and recreate the app (`scripts/vps-compose.sh up -d`).

### Automatic deploys

Like SpaceWorks, an installation can update itself whenever a release is
published. Answer **yes** to *Install a GitHub Actions runner on this server for
automatic deploys?* during setup, or later choose **4) Automatic deploys** in the
installer's menu. The runner (`scripts/install-runner.sh`) asks for a
registration token from the repository's **Settings → Actions → Runners → New
self-hosted runner**, downloads GitHub's official runner, checks it against the
published SHA-256, registers it with the label `spaceworks-events-prod` and runs
it as a systemd service under its own unprivileged account, `swe-runner`.
Then, in the repository:

1. **Settings → Secrets and variables → Actions → Variables:** add `SWE_DEPLOY` = `true`.
2. **Settings → Environments → production → Deployment branches and tags:**
   selected branches, `main` only (optionally add required reviewers).
3. **Settings → Actions → General → Fork pull request workflows:** require approval
   for all external contributors.

Each GitHub Release (a `VERSION` bump reaching `main`) then ends with a `deploy`
job on this server that runs `sudo /usr/local/sbin/swevents-deploy v<version>`,
which runs `scripts/vps-deploy.sh`: a backup, the new images, migrations, health
checks, and the previous release restored if the new one is unhealthy. Nothing
connects in from GitHub; the runner polls outward.

**Security model.** A repository-level runner accepts any workflow that names
its label, so anyone who can push workflows to the repository can run code on
this server. That code runs as `swe-runner`, which has no Docker access; its
only root permission (`/etc/sudoers.d/spaceworks-events-deploy`) is the deploy
wrapper, and `vps-deploy.sh` installs only a published, non-pre-release GitHub
Release whose commit is on `main`. Keep write access to trusted maintainers.
Because `swe-runner` can change every file in the runner's directory
(`/opt/spaceworks-events-runner`), the installer never runs anything from it
as root: the systemd unit `swevents-runner.service` is written by the installer
itself, the runner's files are unpacked as `swe-runner`, and the runner's system
dependencies are installed from a fresh root-owned copy of the checksum-verified
archive. A server set up before this change runs the runner under the unit
GitHub's `svc.sh` created (`actions.runner.<owner>-<repo>.<runner>.service`);
re-registering or removing the runner replaces that unit only after systemd
confirms it is a root-owned file in `/etc/systemd/system` that runs as
`swe-runner` from the runner's directory. If anything differs, the installer
stops and prints the commands to remove the unit by hand. Re-register once
after upgrading (menu option 4) to move an existing runner onto the new unit.
Remove the runner with menu option 4 or
`sudo bash /opt/spaceworks-events/current/scripts/install-runner.sh --remove`,
then delete the `SWE_DEPLOY` variable.

### Other options

`--ref` installs a branch, tag or commit instead and **builds** its images on the
server (versions `vps-<commit>`); a later update moves it to the latest release.
`--dir` changes the installation directory and `--repo owner/name` installs a
fork, which needs its own published release (or `--ref`). Pass options as
`curl … | bash -s -- --dir /srv/spaceworks-events`. To keep secrets somewhere
other than `/etc/spaceworks-events`, set the variable on the `bash` side of the
pipe: `curl … | SWE_CONFIG_DIR=/srv/events-config bash`. Running `curl … | sudo bash`
as root works too. DNS and SMTP provisioning remain operator tasks. On a fresh
install without `--repo`, the installer asks once which repository to install
from (Enter keeps the official one).

Answers are stored in single-quoted env files, so the sender, SMTP login and
password cannot contain `'` or `\`; the installer asks again if they do.

If setup stops after confirmation (a failed build, a full disk), fix the cause and
run the one-liner again: it offers to **resume** that release without generating
new secrets. Only one install, update, backup or restore runs at a time.

From a reviewed checkout, `sudo bash scripts/setup-vps.sh` asks the same questions
and runs the stack from that checkout instead of `/opt/spaceworks-events`. For
explicit commands or automation, follow the manual steps below.

## 1. Get a reviewed release and generate configuration

Clone the repository and check out the reviewed commit you intend to deploy.
Use a new version label for every release, including rebuilds with a changed
public hostname. Build images locally below, or use a trusted build host and
transfer the same versioned images to the VPS.

```bash
git clone https://github.com/SpaceWorks-Labs/SpaceWorks-Events.git
cd SpaceWorks-Events
git checkout <reviewed-commit-or-tag>
SWE_VERSION="vps-$(git rev-parse --short HEAD)"
export SWE_CONFIG_DIR=/etc/spaceworks-events
sudo install -d -m 0700 -o "$(id -u)" -g "$(id -g)" "$SWE_CONFIG_DIR"

# The backend image, with placeholder origins and a throwaway build key.
SWE_BUILD_KEY=$(openssl rand -base64 32) docker build --target runner \
  --build-arg NEXT_PUBLIC_BASE_URL=https://spaceworks-events-origin.invalid \
  --secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=SWE_BUILD_KEY \
  --tag "swevents-backend:$SWE_VERSION" .
docker run --rm --user "$(id -u):$(id -g)" \
  --volume "$SWE_CONFIG_DIR:/config" \
  "swevents-backend:$SWE_VERSION" node docker/vps/setup.mjs \
  events.example.com admin@example.com "$SWE_VERSION"
```

Replace the hostname and admin email. For the split layout, pass the API
hostname first, then the website hostname and `split`
(`api.events.example.com admin@example.com "$SWE_VERSION" events.example.com split`).
Setup refuses an existing configuration;
**do not rerun it to upgrade**. It generates independent application secrets,
separate migration/runtime database passwords, separate storage root/application
credentials, a Redis password and a private CA with certificates for internal
services. It writes them to owner-only files outside Git without printing them.

Edit `$SWE_CONFIG_DIR/app.env` in a trusted editor. Set `EMAIL_FROM`, `SMTP_HOST`,
`SMTP_USER` and `SMTP_PASSWORD` to real values. Use `SMTP_PORT='587'` with
`SMTP_SECURE='false'` for STARTTLS, or port 465 with `SMTP_SECURE='true'` for
implicit TLS, according to your relay. Keep the generated secrets and connection
URLs. Single-quoted environment values preserve literal `$` characters; follow
[Compose's env-file syntax](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)
if a provider credential contains quotes or special characters.

Keep an encrypted backup of this entire directory, especially
`MFA_ENCRYPTION_KEY`, the stable Server Actions key and the CA. Losing the MFA key
makes stored authenticator seeds and instance-managed credentials unreadable.
Do not copy these files into the checkout, publish images publicly, enable shell
tracing, or paste expanded Compose configuration into logs.

## 2. Build, check configuration and start

Run from the checked-out repository with `SWE_CONFIG_DIR` still exported:

```bash
scripts/vps-compose.sh config --quiet
scripts/vps-compose.sh build app            # and frontend, for the split layout
scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/check.mjs preflight
scripts/vps-compose.sh up -d
scripts/vps-compose.sh ps
```

The images carry placeholder origins, replaced when each web container starts,
so they need no rebuild when a hostname changes; every container receives its
own Server Actions key at runtime. Credentials for PostgreSQL, Redis, storage
and SMTP are runtime inputs, not build arguments.

Compose waits for PostgreSQL and Redis health, creates the private storage
bucket and application policy, and applies Prisma migrations before starting the
app, the worker and the beat. Migration failure blocks their startup. Caddy
waits for app health. Caddy obtains and renews the public TLS certificate; it
needs working DNS and reachable ports 80/443. This can take a short time on first startup.

The database rejects non-TLS TCP connections. Redis accepts TLS and password
authentication only. The app verifies internal certificates through the private
CA and uses a database role without superuser, role-management or database-creation
rights. Only the migrator receives the database administration credential; only
storage and its initializer receive the storage root credential. The CA signing
key is never mounted into a running service. Private images and encrypted host
storage remain operator responsibilities.

## 3. Verify and create the first account

```bash
scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/check.mjs
scripts/vps-compose.sh run --rm --no-deps ops node scripts/prisma.mjs migrate status
curl --fail https://events.example.com/api/health
```

The VPS check verifies production settings, live database TLS, the runtime role,
the schema contract, authenticated Redis over TLS, access to the storage bucket
and bearer-protected `/api/health/db`. It never prints credentials or response
bodies. The storage initializer explicitly disables anonymous bucket access.

Set the super-admin password with `sudo bash scripts/vps-recover.sh`: it
creates the `SUPER_ADMIN_EMAIL` account the first time and prints a one-hour
link to set its password. That address can't sign up, use forgot password or
change its password in the app; run the same script again to reset it. Sign in with
the email and password and enter `/super-admin`; there is no separate step-up.
We recommend enabling authenticator MFA from `/account/security`, which is then
asked for at every sign-in. Under **Settings**, verify
SMTP and optionally configure Google SSO. Do not use the demo seed on production.

Before taking registrations, verify a real confirmation email and password-reset
email, upload an event cover, register for a private test event, and check that a
ticket updates immediately when scanned. The proxy flushes streaming responses
for live check-in and overwrites `X-Real-IP`, which is the header this deployment
trusts. Review outbox heartbeat and failed delivery status in the operations area.
The `app` container only serves requests. The `worker` container sends queued
email within seconds, and the `beat` container runs the timed jobs (payment
holds and reminders, waitlists, event reminders, retention, backup alerts); both serve no traffic. The
operations area shows a heartbeat for each. No Cloudflare Worker or host cron is
needed.

## Upgrades and rollback

Run the one-liner again and choose **1) Update to the latest release** (or pass
`--update` to skip the menu). The menu also offers **2) Back up now** and
**3) Check status and health**. The updater:

1. stops if the installation already runs the latest release (`--release` picks
   another, `--ref` a source build);
2. shows the current and new version and asks for confirmation;
3. backs up the database and configuration (`scripts/vps-backup.sh --no-objects`);
4. changes only the version and image names in `compose.env`, downloads the new
   images (or builds them for `--ref`) while the site keeps running, runs
   preflight, applies migrations and verifies the schema;
5. recreates the services (removing any the new release no longer runs, such as
   the old `scheduler`), waits for them to be healthy and runs the VPS checks;
6. points `current` at the new release and keeps the three newest releases and
   their images.

If any step after the backup fails, it restores the previous `compose.env` and
starts the previous release's retained images. **Migrations that already ran are
not reversed**; review migrations before updating, and restore the pre-update
backup if an older release cannot run on the newer schema. For automation, unpack
the new release with its commit in a `.release` file (and, for a published
release, its version in `.release-version`) and run
`sudo bash <new release>/scripts/update-vps.sh --yes`; it is copied into
`releases/` like any other update. For split hosting, deploy
the identical commit to Netlify after the backend update.

For a checkout-based installation, follow the manual steps below.

Back up first and record the current commit and image version. Review database
migrations for compatibility before changing the running installation.

1. Check out the new reviewed commit. Change only `SWE_VERSION` in the external
   `compose.env` to a new, immutable release label; retain all secrets and volumes.
2. Build the new images and run preflight as in step 2 above.
3. Apply migrations once, then verify the schema before replacing the app:

   ```bash
   scripts/vps-compose.sh run --rm migrator
   scripts/vps-compose.sh run --rm --no-deps ops node scripts/verify-production-schema.mjs
   scripts/vps-compose.sh up -d
   scripts/vps-compose.sh run --rm --no-deps ops node docker/vps/check.mjs
   ```

4. Verify public HTTPS, sign-in, email and live check-in. Keep previous images
   until the release is healthy. Do not run `docker image prune -a` during rollout.

To revert application code, restore the previous checkout and its version label,
then recreate the services from those retained images. Reverting images does
**not** undo migrations. A database rollback requires an explicit restore from a
verified backup and a compatible application version. Do not reset volumes to
repair an upgrade.

A hostname change needs matching `PUBLIC_HOST` and `PUBLIC_ORIGIN` in `compose.env`, matching
`AUTH_URL` / `NEXT_PUBLIC_BASE_URL` in `app.env`, a new image version and an app
rebuild. Also update DNS, OAuth callbacks, monitoring and any embeds; retain an
HTTPS redirect for previously shared links. Keep `actions-key` and its matching
runtime key stable across ordinary builds and upgrades.

## Backups and recovery

Persistent volumes hold PostgreSQL, Redis and, when they run here, Silo object storage and Caddy
certificates. Back up **both database and uploaded objects**, plus the external
configuration:

```bash
sudo bash /opt/spaceworks-events/current/scripts/vps-backup.sh
```

The services keep running. The script writes `/etc/spaceworks-events/backups/<UTC time>/`
with a consistent `database.dump` (checked with `pg_restore --list`), `config.tar.gz`
(every secret, including `MFA_ENCRYPTION_KEY` and the CA) and `objects/` (every
uploaded file, mirrored from Silo). `--no-objects` skips the files; updates and
restores use it. A backup stays on the server for `BACKUP_KEEP_DAYS` (default 14),
but the newest three full and three database-only backups always stay, and the
backup being restored is never removed.

Run the installer again and choose **Backups** to change the settings, which are
saved in `/etc/spaceworks-events/backup.env`. Setup asks about the first three:

| Setting | What it does |
| --- | --- |
| **Nightly backups** | A systemd timer (`swevents-backup.timer`) runs a full backup at about 02:30 UTC. |
| **Encryption** | Every backup becomes `backup.tar.age`, encrypted with [age](https://age-encryption.org) to a public key. The private key (`AGE-SECRET-KEY-…`) is shown **once** and is not stored on the server: keep it in your password manager. Only `version` and `kind` stay readable. |
| **Off-site copies** | After each backup, an encrypted copy goes to an S3-compatible bucket at another provider (R2, B2, S3…), kept for its own number of days (default 90). Only encrypted backups are sent. A private endpoint (for example your own Silo or MinIO) can use its own certificate authority: give the CA file when asked, and the installer keeps a copy beside `backup.env`. Keys may contain any characters, including `/` and `+`. |
| **Retention** | Days a backup stays on this server. |

Encryption chosen at setup is never silently skipped. Setup installs `age` and
makes the key before it turns on the nightly timer; if `age` cannot be installed
or cannot encrypt to the key, setup leaves the timer off, records the reason in
the status file and says so. While encryption is on, or was requested and is not
working yet, `vps-backup.sh` refuses to run (this includes the backup the updater
takes first) and records the refusal instead of writing a backup that holds every
secret unencrypted. Install the `age` package, then in **Backups** choose
**Set up the requested encryption** and turn nightly backups on; or, to accept
unencrypted backups, turn the request off there.

Each run writes `/etc/spaceworks-events/status/backup.json` (no secrets), which the
app reads read-only. **Super admin → Operations** shows the newest backup, schedule,
encryption and off-site state. If a backup fails, or scheduled backups are more than
36 hours old, the super admin is emailed once per failure (once a day while stale).
A backup on the same VPS is not a backup of the VPS: turn on off-site copies, or copy
backups away yourself.

To restore on the same installation:

```bash
sudo bash /opt/spaceworks-events/current/scripts/vps-restore.sh /etc/spaceworks-events/backups/<time>
```

For an encrypted backup it asks you to paste the key (or pass `--identity FILE`).
`vps-restore.sh offsite:<time>` first downloads that backup from the off-site
bucket; the installer menu's **Backups → List off-site backups** shows the names.
It shows what will be replaced and asks you to type `RESTORE`. It backs up the
current database first, stops the app, the worker, the beat and Caddy, and
replaces the database in one transaction. It then copies the backup's files back into Silo
(newer files stay), runs migrations if the backup came from an older release,
starts everything and runs the VPS checks.

On a **new server**, restore the configuration before anything else, because the
database holds data encrypted with its keys. Do not run a fresh install: it would
generate different keys. Copy the backup directory to the server (here
`/root/<time>`). If it is encrypted (`backup.tar.age`), install `age` and decrypt it
in place first, with the key saved in `key.txt`:
`age --decrypt --identity key.txt /root/<time>/backup.tar.age | tar -xf - -C /root/<time>`.
Then, as root, unpack the release named in its `version` file and
record it as an unfinished installation:

```bash
backup=/root/<time>
version=$(cat "$backup/version")   # a release such as 0.1.0-main.42.<commit>, or vps-<commit>
case "$version" in vps-*) ref=${version#vps-} ;; *) ref=v$version ;; esac
commit=$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
  "https://api.github.com/repos/SpaceWorks-Labs/SpaceWorks-Events/commits/$ref")
release=/opt/spaceworks-events/releases/$commit
mkdir -p "$release"
curl -fsSL "https://codeload.github.com/SpaceWorks-Labs/SpaceWorks-Events/tar.gz/$commit" | tar -xz -C "$release" --strip-components=1
echo "$commit" > "$release/.release"
case "$version" in vps-*) ;; *) echo "$version" > "$release/.release-version" ;; esac
install -d -m 0700 /etc/spaceworks-events
tar -xzf "$backup/config.tar.gz" -C /etc/spaceworks-events
printf "SWE_CONFIG_DIR='/etc/spaceworks-events'\nSWE_PENDING_RELEASE='%s'\n" "$commit" > /opt/spaceworks-events/install.conf
command -v docker >/dev/null || bash "$release/scripts/install-docker.sh"
```

Run the one-liner and choose **Resume**. It downloads (or, for a `vps-` version,
builds) and starts that release with the restored keys. Then run `vps-restore.sh "$backup"` and point DNS at the new
server. Later updates work as usual.

Nightly, encrypted, off-site backups with alerts cover a day's data loss at most.
For tighter recovery points, add PostgreSQL WAL archiving/PITR yourself, and run
regular restore drills on an isolated host (record them with **Record restore
drill** on the Operations page). The Instance settings backup fields describe a
provider's backups for other deployments and do not create backups. Never run `scripts/vps-compose.sh down --volumes`
on an installation you want to retain. See [Production operations](production-operations.md)
for incident and retention requirements.

## Certificate renewal and monitoring

Caddy renews public HTTPS certificates automatically while DNS and ports remain
reachable. Internal service certificates (PostgreSQL, Redis, Silo) last **one
year**. On installations made by the installer, a weekly systemd timer
(`swevents-certificates.timer`) renews them once they are within 60 days of
expiry, restarts the services and runs the checks; updates add it to older
installations. To renew now, as root:

```bash
sudo bash /opt/spaceworks-events/current/scripts/vps-renew-certs.sh
```

From a checkout without the timer, run the same script there (with
`SWE_CONFIG_DIR` set) at least once a year; `--if-due` renews only when due.
Renewal retains the existing CA and all credentials; expect a short interruption
while services restart. The CA itself lasts ten years and needs a planned trust
rotation before expiry. Monitor disk space, certificate expiry, HTTPS, authenticated
readiness, Redis availability, database connections, outbox failures and fresh
backups. Container restart policies do not restart a process merely because its
healthcheck becomes unhealthy; alert and investigate.

## Changing settings later

Run the installer again and choose **Change settings**:

- **Hostnames.** New website and API hostnames (one hostname in the single layout).
  Point DNS first. Everyone is signed out, and links already sent keep the old
  hostname. On Netlify, set the new values there too.
- **Outgoing email.** New sender, relay, login and password. The installer logs in
  to the relay (`check.mjs smtp`) before keeping the change.
- **Bucket credentials.** A new access key for an external bucket.

Each change backs up the database and configuration, recreates the services and
runs the checks. If anything fails, the previous settings are put back. Moving
between bundled Silo and an external bucket is a data migration, not a setting:
copy the objects with `mc mirror`, then reinstall with the restored configuration.
Email settings saved in **Super admin → Settings** override the installer's; use
**Send test email** on the Operations page to check what is in effect.

## Server security

Setup offers it, and the menu's **Server security** runs it again. Each part is optional:

- **Firewall:** ufw on Debian/Ubuntu, or firewalld where it runs. It allows only
  SSH (every port sshd listens on), HTTP and HTTPS. If the SSH port cannot be
  found, the firewall is left alone so you are not locked out. Docker publishes
  ports past ufw; this stack publishes only 80 and 443, or `127.0.0.1` ports
  behind your own proxy.
- **Automatic security updates:** unattended-upgrades or dnf-automatic, security
  fixes only.
- **fail2ban:** bans an address for an hour after five failed SSH logins.

## Super-admin recovery

If the super admin loses their authenticator or password, someone with root on
the server chooses **Recover super-admin access**. It removes that account's
authenticator and recovery codes, signs it out everywhere, records an audit event
and prints a password-reset link valid for one hour. Open it, set a password, sign
in, then set up an authenticator again.

## Support bundle and uninstall

**Support bundle** collects the release, settings without secrets, service state,
the checks, disk and memory, and the last 500 log lines of each service into
`/opt/spaceworks-events/support/`. Credentials, tokens and keys are redacted, but
logs can hold email and IP addresses, so read it before sharing.

**Uninstall** removes the containers, timers, runner, images and
`/opt/spaceworks-events`. The database and uploads (Docker volumes) and
`/etc/spaceworks-events` (secrets and backups) are kept unless you type
`DELETE DATA`. Docker, swap and any hardening stay in place.

## A separate frontend on Netlify

Choose mode 2 in the installer and follow [Netlify frontend + Docker VPS backend](DEPLOYMENT_SPLIT.md).
The same data services, private TLS, migrations, worker and beat, backups and
renewal procedures apply. `PUBLIC_HOST` is the VPS API hostname; `PUBLIC_ORIGIN`, `AUTH_URL`
and `NEXT_PUBLIC_BASE_URL` are the frontend HTTPS origin. Public variables require
rebuilding the appropriate application image/workspace when changed.
