#!/usr/bin/env bash
# Guided first installation. The curl installer (install.sh) runs it as root
# from a staged source release; a reviewed checkout can run it directly with
# `sudo bash scripts/setup-vps.sh`. Every question comes first and nothing on
# the host changes until the summary is confirmed. Existing installations use
# scripts/update-vps.sh: setup never replaces generated secrets.
# --resume finishes a setup whose configuration was generated but whose build
# or start failed, without generating anything again.
# shellcheck disable=SC2154 # ask assigns answers by name
set -euo pipefail
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
resume=0
case "${1:-}" in
  '') ;;
  --resume) resume=1 ;;
  *) die 'Usage: setup-vps.sh [--resume]' ;;
esac
require_root
[[ $(uname -s) = Linux ]] || die 'Run this on the Linux VPS.'
revision=$(release_revision "$source_dir")
version=$(source_version "$source_dir" "$revision")
published=0
if is_published_version "$version"; then published=1; fi
# Installer-managed when staged by install.sh or already inside $SWE_DIR/releases.
managed=0
case "$source_dir/" in "$SWE_DIR/releases/"*) managed=1 ;; esac
[[ ${SWE_STAGED:-0} != 1 ]] || managed=1
repository=${SWE_REPOSITORY:-$SWE_DEFAULT_REPOSITORY}
is_repository "$repository" || die 'SWE_REPOSITORY must be a GitHub owner/name.'

start_stack() {
  cd "$SWE_REPO_DIR"
  compose config --quiet
  fetch_images "$version" "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_LAYOUT)"
  compose run --rm --no-deps ops node docker/vps/check.mjs preflight
  say 'Starting PostgreSQL, Redis, Silo storage, migrations, the backend and website, the email worker and beat, and Caddy.'
  compose up -d --wait --wait-timeout 300
  compose run --rm --no-deps ops node docker/vps/check.mjs
}

finish() {
  local origin public_host scripts_dir="$SWE_REPO_DIR/scripts"
  if [[ $managed = 1 ]]; then
    activate_release "$SWE_REPO_DIR"
    conf_set "$(install_conf)" SWE_RELEASE "$revision"
    conf_set "$(install_conf)" SWE_PENDING_RELEASE ''
    scripts_dir="$SWE_DIR/current/scripts"
  fi
  origin=$(conf_get "$SWE_CONFIG_DIR/compose.env" PUBLIC_ORIGIN)
  public_host=$(conf_get "$SWE_CONFIG_DIR/compose.env" PUBLIC_HOST)
  layout=$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_LAYOUT)
  cat <<EOF

Space Works Events $version is running.
  Website:        $origin
  API health:     https://$public_host/api/health
  Configuration:  $SWE_CONFIG_DIR (contains every secret; keep an encrypted off-server copy)

Next steps
  1. Set the super-admin password (only possible from this server):
       sudo bash $scripts_dir/vps-recover.sh
     Open the link it prints, sign in, enable authenticator MFA, then open
     /super-admin.
  2. Send a test email, upload an event cover and register for a private test event.
  3. Check backups: run the installer again and choose Backups (schedule,
     encryption, off-site copies), or back up now with
     sudo bash $scripts_dir/vps-backup.sh
EOF
  if [[ $layout = netlify ]]; then
    cat <<EOF
  4. Deploy the website from the same commit ($revision) on Netlify with the
     settings in $SWE_CONFIG_DIR/frontend.env. See docs/DEPLOYMENT_SPLIT.md.
EOF
  fi
  if [[ $managed = 1 ]]; then
    printf '\nRun the installer again at any time to update, back up or check this installation.\n'
  fi
}

# Timers (nightly backups if chosen, certificate renewal) and the encryption key
# chosen during setup. The key is shown once; a resumed setup that already made
# one keeps it. Encryption comes first: while it was requested but does not
# work, the nightly timer is withheld and the reason recorded in the status
# file the Operations page shows (vps-backup.sh refuses such backups too).
finish_backups() {
  local file problem='' kind=full keep
  file=$(backup_env)
  install -d -m 0755 "$(status_dir)"
  if [[ "$(conf_get "$file" BACKUP_ENCRYPTION)" = requested ]]; then
    problem=encryption-unavailable
    if ensure_age; then
      new_backup_key
      problem=$(backup_encryption_problem "$(conf_get "$file" BACKUP_AGE_RECIPIENT)")
    fi
    [[ -n "$problem" ]] || conf_unset "$file" BACKUP_ENCRYPTION
  fi
  if [[ $managed = 1 ]] && has_systemd; then
    install_certificate_timer
    [[ "$(conf_get "$file" BACKUP_SCHEDULE)" != nightly || -n "$problem" ]] || install_backup_timer
  fi
  if [[ -n "$problem" ]]; then
    [[ "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_STORAGE)" != external ]] || kind=database
    keep=$(conf_get "$file" BACKUP_KEEP_DAYS)
    is_days "$keep" || keep=14
    write_backup_status failed "$kind" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 0 false off "$keep" "$problem"
    warn 'Backup encryption could not be set up (age is missing or not working), so no backup is made and nightly backups were not turned on: an unencrypted backup would hold every secret. Install the "age" package, then in the installer menu (Backups) turn on encryption and nightly backups, or turn the encryption request off.'
  fi
  if [[ -n "$(conf_get "$file" OFFSITE_BUCKET)" ]]; then
    run_mc "$(silo_image)" ls "offsite/$(conf_get "$file" OFFSITE_BUCKET)" > /dev/null \
      || warn 'The off-site bucket could not be reached with that key; check it in the installer menu (Backups).'
  fi
}

load_config_dir
if [[ $resume = 1 && ! -f "$SWE_CONFIG_DIR/compose.env" ]]; then
  say 'No configuration was generated yet; starting the guided setup again.'
  resume=0
fi
if [[ $resume = 1 ]]; then
  [[ "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_VERSION)" = "$version" ]] \
    || die 'This source release does not match the configured version; resume from the release setup started with.'
  [[ $managed = 0 ]] || take_lock
  SWE_REPO_DIR=$source_dir
  start_stack
  finish
  finish_backups
  exit 0
fi

require_tty
case "$SWE_CONFIG_DIR/" in "$source_dir/"*|"$SWE_DIR/"*) die 'Keep production configuration outside the source and install directories.' ;; esac
[[ ! -e "$SWE_CONFIG_DIR/compose.env" ]] \
  || die "$SWE_CONFIG_DIR already holds a configuration. Use the update procedure; setup never replaces secrets."
[[ ! -e "$SWE_CONFIG_DIR" || -z "$(ls -A "$SWE_CONFIG_DIR")" ]] \
  || die "$SWE_CONFIG_DIR has files but no configuration. Move them away, then rerun."

# Checks only: nothing changes before the summary is confirmed.
case $(uname -m) in
  x86_64|amd64|aarch64|arm64) ;;
  *) die "Unsupported architecture $(uname -m); use an x86_64 or arm64 server." ;;
esac
disk_mb=$(free_disk_mb /var/lib/docker)
(( disk_mb >= 10240 )) || die "At least 10 GB of free disk is needed for images, data and backups; only $disk_mb MB is free."
has_docker=0
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then has_docker=1; fi
# compose.external-storage.yml uses `!override` (Compose 2.24.4 and later).
if [[ $has_docker = 1 ]]; then
  compose_version=$(docker compose version --short 2>/dev/null | sed 's/^v//')
  printf '%s\n%s\n' 2.24.4 "$compose_version" | sort -V -C \
    || die "Docker Compose ${compose_version:-unknown} is too old; 2.24.4 or newer is needed (Docker's official packages provide it)."
fi
# Published images only need memory to run; a source build needs about 4 GB.
offer_swap=0 needed_mb=1800
[[ $published = 1 ]] || needed_mb=3800
memory=$(memory_mb)
if (( memory + $(swap_mb) < needed_mb )) && [[ ! -e /swapfile ]]; then offer_swap=1; fi

cat >/dev/tty <<EOF

Space Works Events setup - $version from $repository
Answer the questions below. Press Enter to accept a [default].
Nothing on this server changes until you confirm the summary.

EOF
cat >/dev/tty <<'EOF'
Hosting
  1 = website and API containers on this VPS (two hostnames, e.g. events.example.com
      and api.events.example.com; both DNS A records point here)
  2 = one app container on this VPS (one hostname)
  3 = website on Netlify, API on this VPS
EOF
is_hosting() { [[ "$1" =~ ^[123]$ ]]; }
ask hosting_mode 'Hosting' 1 is_hosting 'Enter 1, 2 or 3.'
frontend_host=''
case $hosting_mode in
  1)
    layout='split'
    ask frontend_host 'Website hostname' '' is_hostname 'Enter a hostname such as events.example.com.'
    frontend_host=${frontend_host,,}
    is_api_host() { is_hostname "$1" && [[ "${1,,}" != "$frontend_host" ]]; }
    ask public_host 'API hostname' "api.$frontend_host" is_api_host 'Enter a different hostname, such as api.events.example.com.'
    public_host=${public_host,,}
    site_host=$frontend_host
    ;;
  2)
    layout='single'
    ask public_host 'Public hostname (its DNS A record points at this server)' '' is_hostname 'Enter a hostname such as events.example.com.'
    public_host=${public_host,,}
    site_host=$public_host
    ;;
  3)
    layout='netlify'
    ask public_host 'API hostname for this VPS (DNS A record points here)' '' is_hostname 'Enter a hostname such as api.events.example.com.'
    public_host=${public_host,,}
    is_frontend_host() { is_hostname "$1" && [[ "${1,,}" != "$public_host" ]]; }
    ask frontend_host 'Website hostname on Netlify' '' is_frontend_host 'Enter a different hostname, such as events.example.com or your-site.netlify.app.'
    frontend_host=${frontend_host,,}
    site_host=$frontend_host
    ;;
esac
ask admin_email 'Super-admin email (its password is set from this server)' '' is_email 'Enter an email address.'
cat >/dev/tty <<'EOF'

HTTPS
  1 = LAN or trial: Caddy issues its own certificate (browsers warn until it is trusted)
  2 = automatic HTTPS: Caddy with Let's Encrypt; DNS must point at this server
  3 = I already run a reverse proxy on this server; it forwards HTTPS to this stack
EOF
https_default=2
[[ "${SWE_CADDY_TLS:-}" != internal ]] || https_default=1
[[ "${SWE_CADDY_TLS:-}" != proxy ]] || https_default=3
ask https_mode 'HTTPS' "$https_default" is_hosting 'Enter 1, 2 or 3.'
acme_email=''
[[ $https_mode != 2 ]] || ask acme_email 'Certificate email (Let'"'"'s Encrypt expiry notices)' "$admin_email" is_plain_email 'Enter a plain address such as you@example.com.'
cat >/dev/tty <<'EOF'

File storage (event covers, ID cards, uploads)
  1 = bundled Silo object storage on this server
  2 = an external S3-compatible bucket (Cloudflare R2, Amazon S3...): create a private
      bucket and an access key limited to it first
EOF
is_choice2() { [[ "$1" =~ ^[12]$ ]]; }
ask storage_mode 'File storage' 1 is_choice2 'Enter 1 or 2.'
if [[ $storage_mode = 2 ]]; then
  is_https_endpoint() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; }
  is_bucket() { [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; }
  is_region() { [[ "$1" =~ ^[a-z0-9-]{1,32}$ ]]; }
  ask S3_ENDPOINT 'S3 endpoint' '' is_https_endpoint 'Enter the HTTPS endpoint, such as https://<account>.r2.cloudflarestorage.com.'
  S3_ENDPOINT=${S3_ENDPOINT%/}
  ask S3_REGION 'Region (R2: auto)' auto is_region 'Enter a region such as auto or eu-west-1.'
  ask S3_BUCKET 'Bucket' '' is_bucket 'Enter a bucket name: lowercase letters, digits, dots and hyphens.'
  ask S3_ACCESS_KEY_ID 'Access key ID' '' is_env_value "Enter the access key, without ' or \\ characters."
  ask_secret S3_SECRET_ACCESS_KEY 'Secret access key (hidden)'
fi
printf '\nOutgoing email needs an authenticated SMTP relay on a verified sending domain (Brevo, Amazon SES, Postmark...).\n' >/dev/tty
ask EMAIL_FROM 'Sender, as Name <address@your-verified-domain>' "Space Works Events <events@$site_host>" is_env_value "Enter a sender without ' or \\ characters."
ask SMTP_HOST 'SMTP host' 'smtp-relay.brevo.com' is_hostname 'Enter the relay hostname, such as smtp-relay.brevo.com.'
default_port=587
[[ "${SMTP_HOST,,}" != *brevo.com ]] || default_port=2525
ask SMTP_PORT 'SMTP port (Brevo: 2525 or 587; implicit TLS: 465)' "$default_port" is_port 'Enter a port number between 1 and 65535.'
SMTP_SECURE=false
if [[ $SMTP_PORT = 465 ]]; then SMTP_SECURE=true; fi
ask SMTP_USER 'SMTP login' '' is_env_value "Enter the login, without ' or \\ characters."
ask_secret SMTP_PASSWORD 'SMTP password or key (hidden)'
install_runner=0
# Only installs made by the one-line installer can update themselves.
if [[ $managed = 1 ]] && command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
  confirm 'Install a GitHub Actions runner on this server for automatic deploys of new releases?' N && install_runner=1
fi
schedule_backups=0 encrypt_backups=0 offsite=0 harden=0
printf '\nBackups (database, configuration and uploads; change them later from the installer menu)\n' >/dev/tty
# Timers point at the installer's current release, so only managed installs get them.
if [[ $managed = 1 ]] && has_systemd; then
  confirm 'Back up every night?' Y && schedule_backups=1
fi
confirm 'Encrypt backups with a key you keep off this server (shown once at the end)?' Y && encrypt_backups=1
if [[ $encrypt_backups = 1 ]] && confirm 'Also copy each backup to an off-site S3 bucket?' N; then
  ask_offsite
  offsite=1
fi
printf '\n' >/dev/tty
confirm 'Harden this server: a firewall allowing only SSH, HTTP and HTTPS, automatic security updates and fail2ban?' N && harden=1
make_swap=0
if [[ $offer_swap = 1 ]] && confirm "This server has $memory MB of memory; Space Works Events needs about $(( (needed_mb + 999) / 1000 )) GB. Create a 4 GB swap file at /swapfile?" Y; then
  make_swap=1
fi
# Ports: Caddy needs 80/443; behind an existing proxy the stack listens on localhost.
ports=(80 443)
if [[ $https_mode = 3 ]]; then ports=(8080); [[ $layout != split ]] || ports+=(8081); fi
for port in "${ports[@]}"; do
  ! port_in_use "$port" || die "TCP port $port is already in use. Free it, then rerun."
done
resolves() { getent ahosts "$1" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ' || true; }
dns=$(resolves "$public_host")
site_dns=''
[[ $layout != split ]] || site_dns=$(resolves "$frontend_host")

install_path=$source_dir
[[ $managed = 0 ]] || install_path="$SWE_DIR/releases/$revision"
{
  printf '\nSummary\n'
  printf '  Release:         %s (%s, commit %s)\n' "$version" "$repository" "${revision:0:12}"
  if [[ $published = 1 ]]; then
    printf '  Images:          published release images from ghcr.io/%s\n' "$(printf '%s' "${repository%%/*}" | tr '[:upper:]' '[:lower:]')"
  else
    printf '  Images:          built on this server from source (several minutes)\n'
  fi
  printf '  Installed to:    %s\n' "$install_path"
  printf '  Configuration:   %s (secrets, owner-only)\n' "$SWE_CONFIG_DIR"
  printf '  Website:         https://%s\n' "$site_host"
  case $layout in
    split) printf '  API:             https://%s (both run on this VPS)\n' "$public_host" ;;
    netlify) printf '  API (this VPS):  https://%s (deploy the website to Netlify afterwards)\n' "$public_host" ;;
  esac
  printf '  Super admin:     %s\n' "$admin_email"
  printf '  Email:           %s via %s:%s (implicit TLS: %s)\n' "$EMAIL_FROM" "$SMTP_HOST" "$SMTP_PORT" "$SMTP_SECURE"
  if [[ $layout = split ]]; then
    printf '  Services:        website (frontend) and API (backend) containers, PostgreSQL 16, Redis 7,\n'
  else
    printf '  Services:        app (backend) container, PostgreSQL 16, Redis 7,\n'
  fi
  [[ $storage_mode = 2 ]] || printf '                   Silo object storage,\n'
  case $https_mode in
    1) printf '                   Caddy HTTPS with its own local certificate on ports 80/443,\n' ;;
    2) printf '                   Caddy automatic HTTPS (Let'"'"'s Encrypt, %s) on ports 80/443,\n' "$acme_email" ;;
    3) printf '                   no Caddy: your proxy forwards to 127.0.0.1:8080%s,\n' "$([[ $layout != split ]] || echo ' (API) and :8081 (website)')" ;;
  esac
  printf '                   one-shot migrations, an email worker and a beat for timed jobs (Docker Compose project swevents)\n'
  [[ $storage_mode = 1 ]] || printf '  File storage:    bucket %s at %s (region %s)\n' "$S3_BUCKET" "$S3_ENDPOINT" "$S3_REGION"
  [[ $install_runner = 0 ]] || printf '  Auto-deploy:     GitHub Actions runner (asks for a registration token at the end)\n'
  if [[ $schedule_backups = 1 ]]; then backup_line='nightly at about 02:30 UTC, kept 14 days'; else backup_line='when you run them (installer menu)'; fi
  [[ $encrypt_backups = 0 ]] || backup_line+=', encrypted (key shown once at the end)'
  [[ $offsite = 0 ]] || backup_line+=", copied to $offsite_bucket"
  printf '  Backups:         %s\n' "$backup_line"
  printf '  DNS:             %s\n' "${dns:-$public_host does not resolve yet; HTTPS starts working once it points here}"
  [[ $layout != split ]] || printf '                   %s\n' "${site_dns:-$frontend_host does not resolve yet}"
  printf 'Host changes\n'
  [[ $make_swap = 0 ]] || printf '  - create and enable a 4 GB swap file at /swapfile\n'
  [[ $has_docker = 1 ]] || printf '  - install Docker Engine and Docker Compose from the official repositories\n'
  [[ $encrypt_backups = 0 ]] || command -v age >/dev/null || printf '  - install age (backup encryption) from the distribution packages\n'
  if [[ $managed = 1 ]] && has_systemd; then
    printf '  - add systemd timers: %sweekly renewal of internal certificates when due\n' "$([[ $schedule_backups = 0 ]] || echo 'nightly backups, ')"
  fi
  [[ $harden = 0 ]] || printf '  - turn on a firewall (SSH, HTTP, HTTPS), automatic security updates and fail2ban\n'
  printf '  - generate secrets and private TLS certificates in %s\n' "$SWE_CONFIG_DIR"
  if [[ $published = 1 ]]; then fetch=download; else fetch=build; fi
  printf '  - %s images, create volumes, apply database migrations and start the services\n\n' "$fetch"
} >/dev/tty
confirm 'Proceed?' Y || { say 'Cancelled. Nothing was changed.'; exit 2; }

[[ $make_swap = 0 ]] || create_swap 4096
[[ $has_docker = 1 ]] || bash "$source_dir/scripts/install-docker.sh"
if ! docker info >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1 || die 'Docker is installed but not running. Start it (systemctl start docker) and resume.'
fi
SWE_REPO_DIR=$source_dir
if [[ $managed = 1 ]]; then
  take_lock
  SWE_REPO_DIR=$(promote_release "$source_dir" "$revision")
  conf_set "$(install_conf)" SWE_CONFIG_DIR "$SWE_CONFIG_DIR"
  conf_set "$(install_conf)" SWE_REPOSITORY "$repository"
  conf_set "$(install_conf)" SWE_PENDING_RELEASE "$revision"
fi
cd "$SWE_REPO_DIR"
# The backend image carries the operator tools (run as root to write /config).
ops_image="swevents-backend:$version"
if [[ $published = 1 ]]; then
  ops_image="ghcr.io/$(printf '%s' "${repository%%/*}" | tr '[:upper:]' '[:lower:]')/spaceworks-events-backend:$version"
  say 'Downloading the backend image, then generating secrets and internal certificates.'
  docker pull --quiet "$ops_image" >/dev/null || die "Cannot download $ops_image. Check that the release's packages are public on GitHub."
else
  say 'Building the backend image (several minutes), then generating secrets and internal certificates.'
  # Origins are placeholders and the build key is throwaway: containers get theirs at runtime.
  SWE_BUILD_KEY=$(head -c 32 /dev/urandom | base64) docker build --quiet --target runner \
    --build-arg NEXT_PUBLIC_BASE_URL=https://spaceworks-events-origin.invalid \
    --secret id=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY,env=SWE_BUILD_KEY --tag "$ops_image" . >/dev/null
fi
# Generate everything beside the final directory and rename it into place, so an
# interrupted run never leaves a half-written configuration behind.
staging_config="$SWE_CONFIG_DIR.partial"
rm -rf -- "$staging_config"
install -d -m 0700 "$staging_config"
docker run --rm --user 0:0 --volume "$staging_config:/config" "$ops_image" \
  node docker/vps/setup.mjs "$public_host" "$admin_email" "$version" "$frontend_host" "$layout" >/dev/null
set_image_settings "$staging_config/compose.env" "$version" "$repository"
# LAN and test installs: Caddy's local CA instead of public certificates.
case $https_mode in
  1) conf_set "$staging_config/compose.env" SWE_CADDY_TLS internal ;;
  2) conf_set "$staging_config/compose.env" SWE_CADDY_OPTIONS "email $acme_email" ;;
  3) conf_set "$staging_config/compose.env" SWE_CADDY_TLS proxy ;;
esac
if [[ $storage_mode = 2 ]]; then
  conf_set "$staging_config/compose.env" SWE_STORAGE external
  export S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
  docker run --rm --user 0:0 --volume "$staging_config:/config" \
    --env S3_ENDPOINT --env S3_REGION --env S3_BUCKET --env S3_ACCESS_KEY_ID --env S3_SECRET_ACCESS_KEY \
    "$ops_image" node docker/vps/configure-storage.mjs
  unset S3_SECRET_ACCESS_KEY S3_ACCESS_KEY_ID
fi
export EMAIL_FROM SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASSWORD
docker run --rm --user 0:0 --volume "$staging_config:/config" \
  --env EMAIL_FROM --env SMTP_HOST --env SMTP_PORT --env SMTP_SECURE --env SMTP_USER --env SMTP_PASSWORD \
  "$ops_image" node docker/vps/configure-smtp.mjs
unset SMTP_PASSWORD SMTP_USER
# Backup choices are saved now, so a resumed setup finishes them too.
conf_set "$staging_config/backup.env" BACKUP_KEEP_DAYS 14
[[ $schedule_backups = 0 ]] || conf_set "$staging_config/backup.env" BACKUP_SCHEDULE nightly
[[ $encrypt_backups = 0 ]] || conf_set "$staging_config/backup.env" BACKUP_ENCRYPTION requested
[[ $offsite = 0 ]] || save_offsite "$staging_config/backup.env"
unset offsite_secret
rmdir "$SWE_CONFIG_DIR" 2>/dev/null || true
mv -T "$staging_config" "$SWE_CONFIG_DIR"
install -d -m 0755 "$(status_dir)"
start_stack
finish
finish_backups
if [[ $harden = 1 ]]; then
  bash "$SWE_REPO_DIR/scripts/vps-harden.sh" --all || warn 'Hardening did not finish. Run it again from the installer menu (Server security).'
fi
if [[ $install_runner = 1 ]]; then
  bash "$SWE_REPO_DIR/scripts/install-runner.sh" \
    || warn 'The runner was not installed. Run the installer again and choose the auto-deploy option.'
fi
