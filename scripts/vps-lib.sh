# Shared helpers for the VPS setup, update, backup, restore and status scripts.
# Sourced, never executed. Prompts read the terminal directly because
# `curl | bash` feeds the installer itself on stdin.
# shellcheck shell=bash

SWE_DIR=${SWE_DIR:-/opt/spaceworks-events}
SWE_DEFAULT_CONFIG_DIR=/etc/spaceworks-events
# shellcheck disable=SC2034 # used by the scripts that source this file
SWE_DEFAULT_REPOSITORY=SpaceWorks-Labs/SpaceWorks-Events

say() { printf '[Space Works Events] %s\n' "$*"; }
warn() { printf '[Space Works Events] WARNING: %s\n' "$*" >&2; }
die() { printf '[Space Works Events] ERROR: %s\n' "$*" >&2; exit 1; }

require_root() { [[ $(id -u) = 0 ]] || die 'Run this as root (sudo bash ...).'; }
require_tty() { { : </dev/tty; } 2>/dev/null || die 'An interactive terminal is required.'; }

is_hostname() { [[ ${#1} -le 253 && "$1" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$ ]]; }
is_email() { [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] && is_env_value "$1"; }
# Stricter, for values that end up in the Caddyfile.
is_plain_email() { [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }
is_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
is_nonempty() { [[ -n "${1//[[:space:]]/}" ]]; }
# Answers are stored as single-quoted env-file values, which cannot hold ' or \.
is_env_value() { is_nonempty "$1" && [[ "$1" != *[\'\\]* ]]; }
is_mode() { [[ "$1" = 1 || "$1" = 2 ]]; }
is_safe_path() { [[ "$1" = /* && "$1" != / && "$1" != *[[:space:]:\'\"]* ]]; }
is_repository() { [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$ && "$1" != */. && "$1" != */.. ]]; }

# ask VAR "Question" DEFAULT VALIDATOR "Hint shown when the answer is invalid"
# Asks again until the validator accepts the answer (Enter takes the default).
ask() {
  local var=$1 question=$2 default=${3-} check=${4:-is_nonempty} hint=${5:-'Please enter a valid value.'} reply
  while true; do
    if [[ -n "$default" ]]; then printf '%s [%s]: ' "$question" "$default" >/dev/tty
    else printf '%s: ' "$question" >/dev/tty; fi
    IFS= read -r reply </dev/tty || die 'No terminal input; run this in an interactive terminal.'
    reply=${reply%$'\r'}
    reply=${reply:-$default}
    if "$check" "$reply"; then printf -v "$var" '%s' "$reply"; return 0; fi
    printf '  %s\n' "$hint" >/dev/tty
  done
}

# ask_secret VAR "Question": hidden input, asked again until it can be stored.
ask_secret() {
  local var=$1 question=$2 reply
  while true; do
    printf '%s: ' "$question" >/dev/tty
    IFS= read -r -s reply </dev/tty || die 'No terminal input; run this in an interactive terminal.'
    printf '\n' >/dev/tty
    reply=${reply%$'\r'}
    if is_env_value "$reply"; then printf -v "$var" '%s' "$reply"; return 0; fi
    printf "  A value is required, without ' or \\\\ characters.\n" >/dev/tty
  done
}

# confirm "Question" Y|N: succeeds on yes. The default is taken on Enter.
confirm() {
  local question=$1 default=${2:-N} reply
  while true; do
    if [[ "$default" = Y ]]; then printf '%s [Y/n]: ' "$question" >/dev/tty
    else printf '%s [y/N]: ' "$question" >/dev/tty; fi
    IFS= read -r reply </dev/tty || die 'No terminal input; run this in an interactive terminal.'
    reply=${reply%$'\r'}
    case "${reply:-$default}" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo]) return 1 ;;
    esac
    printf '  Answer y or n.\n' >/dev/tty
  done
}

# Values written by these scripts only; parsed, never sourced.
conf_get() {
  local file=$1 name=$2 value
  [[ -f "$file" ]] || return 0
  value=$(sed -n "s/^$name=//p" "$file" | tail -n 1 | tr -d '\r')
  value=${value#\'}; value=${value%\'}
  printf '%s' "$value"
}

conf_set() {
  local file=$1 name=$2 value=$3
  touch "$file"
  { grep -v "^$name=" "$file" || true; printf "%s='%s'\n" "$name" "$value"; } > "$file.new"
  chmod 600 "$file.new"
  mv -f "$file.new" "$file"
}

conf_unset() {
  local file=$1 name=$2
  [[ -f "$file" ]] || return 0
  { grep -v "^$name=" "$file" || true; } > "$file.new"
  chmod 600 "$file.new"
  mv -f "$file.new" "$file"
}

install_conf() { printf '%s/install.conf' "$SWE_DIR"; }

# The configuration directory recorded by the installer, else the default.
load_config_dir() {
  local recorded
  recorded=$(conf_get "$(install_conf)" SWE_CONFIG_DIR)
  SWE_CONFIG_DIR=${SWE_CONFIG_DIR:-${recorded:-$SWE_DEFAULT_CONFIG_DIR}}
  is_safe_path "$SWE_CONFIG_DIR" || die 'SWE_CONFIG_DIR must be an absolute path without spaces, quotes or colons.'
  export SWE_CONFIG_DIR
}

release_revision() {
  local dir=$1 revision
  revision=$(cat "$dir/.release" 2>/dev/null || git -C "$dir" rev-parse HEAD 2>/dev/null || true)
  [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || die "Cannot tell which commit $dir contains (no .release file or Git history)."
  printf '%s' "$revision"
}

release_version() { printf 'vps-%s' "${1:0:12}"; }

# A published release (install.sh writes its image version to .release-version)
# pulls images from GitHub Packages; any other source is built on this server.
is_published_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[a-z0-9-]+\.[0-9]+\.[0-9a-f]{12}$ ]]; }
source_version() {
  local dir=$1 revision=$2 published
  published=$(cat "$dir/.release-version" 2>/dev/null || true)
  if [[ -z "$published" ]]; then release_version "$revision"; return 0; fi
  is_published_version "$published" && [[ "${published: -12}" = "${revision:0:12}" ]] \
    || die "$dir/.release-version does not match its commit."
  printf '%s' "$published"
}

# Point compose.env at the images for VERSION: GitHub Packages for a published
# release, local names (compose.production.yml defaults) for a source build.
set_image_settings() {
  local file=$1 version=$2 repository=$3 prefix='' name
  if is_published_version "$version"; then
    prefix="ghcr.io/$(printf '%s' "${repository%%/*}" | tr '[:upper:]' '[:lower:]')/spaceworks-events"
  fi
  conf_set "$file" SWE_BACKEND_IMAGE "${prefix:+$prefix-backend}"
  conf_set "$file" SWE_FRONTEND_IMAGE "${prefix:+$prefix-frontend}"
  # Settings of releases before 0.9.1, which had separate migrator and ops images.
  for name in SWE_APP_IMAGE SWE_MIGRATOR_IMAGE SWE_OPS_IMAGE; do conf_unset "$file" "$name"; done
}

# Pull a published release's images, or build them from this source. The
# backend image also runs migrations and the operator tools; the frontend
# image is needed only by the split layout.
fetch_images() {
  local version=$1 layout=${2:-single} services=(app)
  [[ "$layout" != split ]] || services+=(frontend)
  if is_published_version "$version"; then
    say 'Downloading the release images from GitHub Packages.'
    compose pull --quiet "${services[@]}"
  else
    say 'Building images from source. This takes several minutes on a small server.'
    compose build "${services[@]}"
  fi
}

# One installer, updater, backup or restore at a time per installation. Child
# scripts run by a lock holder inherit the lock.
take_lock() {
  [[ ${SWE_LOCK_HELD:-0} != 1 ]] || return 0
  mkdir -p "$SWE_DIR"
  exec 9>"$SWE_DIR/.lock"
  if command -v flock >/dev/null; then
    flock -n 9 || die 'Another Space Works Events install, update, backup or restore is running.'
  fi
  export SWE_LOCK_HELD=1
}

# Copy a staged source release into $SWE_DIR/releases/<commit> and print its path.
# A release that is already in place is reused, taking the staged image version.
promote_release() {
  local source=$1 revision=$2 target="$SWE_DIR/releases/$2"
  case "$source/" in "$SWE_DIR/releases/"*) printf '%s' "$source"; return 0 ;; esac
  # Called in a command substitution, where errexit does not apply: check each step.
  if [[ ! -d "$target" ]]; then
    if ! { mkdir -p "$SWE_DIR/releases" && rm -rf "$target.partial" && cp -R "$source" "$target.partial" \
      && chown -R 0:0 "$target.partial" && chmod -R go-w "$target.partial" && mv "$target.partial" "$target"; }; then
      rm -rf "$target.partial"
      return 1
    fi
  elif [[ -f "$source/.release-version" ]]; then
    cp "$source/.release-version" "$target/.release-version" || return 1
  else
    rm -f "$target/.release-version" || return 1
  fi
  printf '%s' "$target"
}

activate_release() {
  ln -sfn "$1" "$SWE_DIR/current.new"
  mv -Tf "$SWE_DIR/current.new" "$SWE_DIR/current"
}

# A TCP port with a listener on this host (IPv4 or IPv6).
port_in_use() {
  local hex file
  printf -v hex '%04X' "$1"
  for file in /proc/net/tcp /proc/net/tcp6; do
    [[ -r "$file" ]] || continue
    awk -v wanted="$hex" 'NR > 1 { split($2, address, ":"); if (toupper(address[2]) == wanted && $4 == "0A") found = 1 } END { exit !found }' "$file" && return 0
  done
  return 1
}

free_disk_mb() {
  local path=$1
  while [[ ! -e "$path" ]]; do path=$(dirname "$path"); done
  df -Pm "$path" | awk 'NR == 2 { print $4 }'
}

memory_mb() { awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo; }
swap_mb() { awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo; }

# Building the Next.js image needs roughly 4 GB of memory; small VPS plans get swap.
# Some hosts (OpenVZ/LXC containers, some btrfs roots) refuse swap files: warn and go on.
create_swap() {
  local file=/swapfile size_mb=$1
  say "Creating a ${size_mb} MB swap file at $file."
  if [[ $(stat -f -c %T / 2>/dev/null) = btrfs ]] && command -v btrfs >/dev/null; then
    btrfs filesystem mkswapfile --size "${size_mb}m" "$file" >/dev/null 2>&1 || true
  else
    if { fallocate -l "${size_mb}M" "$file" 2>/dev/null || dd if=/dev/zero of="$file" bs=1M count="$size_mb" status=none; } \
      && chmod 600 "$file"; then
      mkswap "$file" >/dev/null 2>&1 || true
    fi
  fi
  if [[ -f "$file" ]] && swapon "$file" 2>/dev/null; then
    grep -q "^$file " /etc/fstab || printf '%s none swap sw 0 0\n' "$file" >> /etc/fstab
  else
    rm -f "$file"
    warn 'This server does not allow a swap file; the image build may run out of memory.'
  fi
}

# Install distribution packages with the family's package manager.
install_packages() {
  # shellcheck disable=SC1091
  ( . /etc/os-release
    case " ${ID:-} ${ID_LIKE:-} " in
      *" debian "*|*" ubuntu "*) export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq "$@" ;;
      *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*) dnf install -y "$@" 2>/dev/null || yum install -y "$@" ;;
      *" arch "*|*" manjaro "*) pacman -Syu --noconfirm --needed "$@" ;;
      *" suse "*|*" opensuse "*|*" sles "*) zypper --non-interactive install "$@" ;;
      *) exit 1 ;;
    esac ) || die "Could not install $*; install it with your package manager, then rerun."
}

has_systemd() { command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; }

# Backup settings (schedule, retention, encryption recipient, off-site bucket):
# owner-only, beside the other configuration, parsed with conf_get.
backup_env() { printf '%s/backup.env' "$SWE_CONFIG_DIR"; }
# Non-secret status the app reads (mounted read-only at /status).
status_dir() { printf '%s/status' "$SWE_CONFIG_DIR"; }

# install_timer NAME "Description" ONCALENDAR SCRIPT [ARGS...]: a systemd timer
# that runs a script of the current release as root. The unit names the
# current symlink, so updates never need to rewrite it.
install_timer() {
  local name=$1 description=$2 calendar=$3 script=$4 arg command
  shift 4
  command="/bin/bash $SWE_DIR/current/scripts/$script"
  for arg in "$@"; do command+=" $arg"; done
  cat > "/etc/systemd/system/swevents-$name.service" <<EOF
[Unit]
Description=Space Works Events: $description
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=SWE_DIR=$SWE_DIR
ExecStart=$command
EOF
  cat > "/etc/systemd/system/swevents-$name.timer" <<EOF
[Unit]
Description=Space Works Events: $description

[Timer]
OnCalendar=$calendar
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now "swevents-$name.timer" >/dev/null 2>&1
}

remove_timer() {
  has_systemd || return 0
  systemctl disable --now "swevents-$1.timer" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/swevents-$1.timer" "/etc/systemd/system/swevents-$1.service"
  systemctl daemon-reload
}

timer_enabled() { has_systemd && systemctl is-enabled --quiet "swevents-$1.timer" 2>/dev/null; }

# Nightly backups (02:30 UTC plus up to 30 minutes) and a weekly check that
# renews the internal service certificates two months before they expire.
install_backup_timer() { install_timer backup 'nightly backup' '*-*-* 02:30:00 UTC' vps-backup.sh; }
install_certificate_timer() { install_timer certificates 'internal certificate renewal' 'Mon *-*-* 04:00:00 UTC' vps-renew-certs.sh --if-due; }

# The backend image of the installed release, which carries the operator tools.
backend_image() {
  local image
  image=$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_BACKEND_IMAGE)
  printf '%s:%s' "${image:-swevents-backend}" "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_VERSION)"
}

# The Silo image from the compose file: its `mc` client copies backups to and
# from S3 buckets without installing anything on the host.
silo_image() { sed -n 's/^[[:space:]]*image:[[:space:]]*\(pgsty\/silo:[^[:space:]]*\)[[:space:]]*$/\1/p' "$SWE_REPO_DIR/compose.production.yml" | head -n 1; }

is_https_endpoint() { [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]; }
is_bucket() { [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; }
is_region() { [[ "$1" =~ ^[a-z0-9-]{1,32}$ ]]; }
is_days() { [[ "$1" =~ ^[1-9][0-9]{0,3}$ ]]; }
is_prefix() { [[ "$1" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; }

json_string() { local value=${1//\\/\\\\}; printf '"%s"' "${value//\"/\\\"}"; }

# run_mc [DOCKER OPTIONS...] IMAGE MC-ARGS...: the mc client with the off-site
# bucket as alias `offsite`. The keys go into a private, owner-only mc config
# for this one call (under backups/, which configuration backups skip), never
# into a URL or onto a command line: mc does not decode a URL's userinfo, so
# secrets with "/" or "+" would otherwise be sent wrong.
run_mc() {
  local file home status=0 ca=()
  file=$(backup_env)
  mkdir -p "$SWE_CONFIG_DIR/backups"
  home=$(mktemp -d "$SWE_CONFIG_DIR/backups/.mc.XXXXXX")
  # Readable by the container whatever user it runs as; the owner-only
  # configuration directory around it keeps other host users out.
  chmod 0755 "$home"
  mkdir -m 0755 "$home/.mc"
  ( umask 022
    printf '{"version":"10","aliases":{"offsite":{"url":%s,"accessKey":%s,"secretKey":%s,"api":"s3v4","path":"auto"}}}\n' \
      "$(json_string "$(conf_get "$file" OFFSITE_ENDPOINT)")" "$(json_string "$(conf_get "$file" OFFSITE_ACCESS_KEY_ID)")" \
      "$(json_string "$(conf_get "$file" OFFSITE_SECRET_ACCESS_KEY)")" > "$home/.mc/config.json" )
  # A private endpoint's own CA (OFFSITE_CA names a file in the configuration directory).
  if [[ -n "$(conf_get "$file" OFFSITE_CA)" ]]; then
    ca=(--volume "$SWE_CONFIG_DIR/$(conf_get "$file" OFFSITE_CA):/offsite-ca.crt:ro" --env SSL_CERT_FILE=/offsite-ca.crt)
  fi
  docker run --rm --env HOME=/mc-home --env MC_CONFIG_DIR=/mc-home/.mc --volume "$home:/mc-home" "${ca[@]}" --entrypoint mc "$@" || status=$?
  rm -rf -- "$home"
  return "$status"
}
offsite_path() {
  local file
  file=$(backup_env)
  printf 'offsite/%s/%s' "$(conf_get "$file" OFFSITE_BUCKET)" "$(conf_get "$file" OFFSITE_PREFIX)"
}

# ask_offsite: the off-site bucket questions (answers in offsite_* variables).
ask_offsite() {
  cat >/dev/tty <<'EOF'

Off-site copies go to an S3-compatible bucket at another provider (Cloudflare R2,
Backblaze B2, Amazon S3...). Create a private bucket and a key limited to it.
EOF
  ask offsite_endpoint 'Off-site S3 endpoint' '' is_https_endpoint 'Enter the HTTPS endpoint, such as https://<account>.r2.cloudflarestorage.com.'
  offsite_endpoint=${offsite_endpoint%/}
  # Your own MinIO, Silo or Garage may use a private CA; cloud providers do not.
  ask offsite_ca 'CA certificate file, only for a private endpoint (none if it has a public certificate)' none is_ca_file 'Enter the path of a PEM certificate file, or none.'
  [[ "$offsite_ca" != none ]] || offsite_ca=''
  ask offsite_bucket 'Off-site bucket' '' is_bucket 'Enter a bucket name: lowercase letters, digits, dots and hyphens.'
  ask offsite_prefix 'Folder in the bucket' spaceworks-events is_prefix 'Use letters, digits, dots, hyphens and underscores.'
  ask offsite_key 'Access key ID' '' is_env_value "Enter the access key, without ' or \\ characters."
  ask_secret offsite_secret 'Secret access key (hidden)'
  ask offsite_days 'Days to keep off-site copies' 90 is_days 'Enter a number of days.'
}

is_ca_file() { [[ "$1" = none ]] || { is_safe_path "$1" && [[ -f "$1" && -r "$1" ]] && grep -q 'BEGIN CERTIFICATE' "$1"; }; }

# shellcheck disable=SC2154 # ask_offsite assigns these by name
save_offsite() {
  local file=${1:-$(backup_env)}
  # The CA is copied beside the settings (owner-only), so it is kept with the configuration.
  if [[ -n "${offsite_ca:-}" ]]; then
    install -m 0600 "$offsite_ca" "$(dirname "$file")/offsite-ca.crt"
    conf_set "$file" OFFSITE_CA offsite-ca.crt
  else
    conf_unset "$file" OFFSITE_CA
  fi
  conf_set "$file" OFFSITE_ENDPOINT "$offsite_endpoint"
  conf_set "$file" OFFSITE_BUCKET "$offsite_bucket"
  conf_set "$file" OFFSITE_PREFIX "$offsite_prefix"
  conf_set "$file" OFFSITE_ACCESS_KEY_ID "$offsite_key"
  conf_set "$file" OFFSITE_SECRET_ACCESS_KEY "$offsite_secret"
  conf_set "$file" OFFSITE_KEEP_DAYS "$offsite_days"
}

clear_offsite() {
  local name
  for name in OFFSITE_ENDPOINT OFFSITE_BUCKET OFFSITE_PREFIX OFFSITE_ACCESS_KEY_ID OFFSITE_SECRET_ACCESS_KEY OFFSITE_KEEP_DAYS OFFSITE_CA; do
    conf_unset "$(backup_env)" "$name"
  done
  rm -f "$SWE_CONFIG_DIR/offsite-ca.crt"
}

# The age tool encrypts backups to a public key; only its private key, kept
# off this server, can decrypt them.
ensure_age() {
  command -v age >/dev/null && command -v age-keygen >/dev/null && return 0
  say 'Installing age (backup encryption) from the distribution packages.'
  ( install_packages age ) >/dev/null 2>&1 || true
  command -v age >/dev/null && command -v age-keygen >/dev/null
}

# new_backup_key: create an age key pair, save the public recipient and show
# the private key once. It is never written to this server.
new_backup_key() {
  local identity recipient answer
  identity=$(age-keygen 2>/dev/null)
  recipient=$(printf '%s\n' "$identity" | age-keygen -y)
  [[ "$recipient" =~ ^age1[a-z0-9]{58}$ ]] || die 'age-keygen did not produce a key.'
  conf_set "$(backup_env)" BACKUP_AGE_RECIPIENT "$recipient"
  cat >/dev/tty <<EOF

Backup encryption key. Store it now in your password manager or another
safe place OFF this server. It is shown only this once and is not saved here.
Without it, encrypted backups cannot be restored.

$(printf '%s\n' "$identity" | grep '^AGE-SECRET-KEY-')

EOF
  while true; do
    printf 'Type SAVED once the key is stored safely: ' >/dev/tty
    IFS= read -r answer </dev/tty || die 'No terminal input.'
    [[ "${answer%$'\r'}" != SAVED ]] || break
  done
  printf '\033[2J\033[H' >/dev/tty
}

# These scripts never attach a terminal to a container: the installer runs them
# with stdin from /dev/null, and Compose refuses a TTY without one.
compose() {
  case "${1:-}" in
    run|exec) local command=$1; shift; sh "$SWE_REPO_DIR/scripts/vps-compose.sh" "$command" -T "$@" ;;
    *) sh "$SWE_REPO_DIR/scripts/vps-compose.sh" "$@" ;;
  esac
}
