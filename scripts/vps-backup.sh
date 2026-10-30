#!/usr/bin/env bash
# Back up the database, the configuration and the uploaded objects into
# $SWE_CONFIG_DIR/backups/<UTC time>/ while the services keep running. The
# database dump is a consistent snapshot; objects are copied one by one.
#   --no-objects  database and configuration only (used before updates)
# Settings live in $SWE_CONFIG_DIR/backup.env (installer menu: Backups):
#   BACKUP_KEEP_DAYS        days a backup stays on this server (default 14); the
#                           newest three of each kind are always kept
#   BACKUP_AGE_RECIPIENT    encrypt every backup to this age public key
#   BACKUP_ENCRYPTION       "requested" while encryption chosen at setup is not
#                           working yet; backups are refused until it is
#   OFFSITE_*               copy each backup to an S3 bucket (needs encryption)
# A systemd timer (swevents-backup.timer) runs it nightly when scheduled. Each
# run records its outcome in $SWE_CONFIG_DIR/status/backup.json, which the
# super-admin Operations page shows and alerts on.
set -euo pipefail
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
objects=1
case "${1:-}" in
  '') ;;
  --no-objects) objects=0 ;;
  *) die 'Usage: vps-backup.sh [--no-objects]' ;;
esac
require_root
load_config_dir
[[ -f "$SWE_CONFIG_DIR/compose.env" ]] || die "No installation configuration in $SWE_CONFIG_DIR."
settings=$(backup_env)
keep_days=$(conf_get "$settings" BACKUP_KEEP_DAYS)
keep_days=${keep_days:-14}
is_days "$keep_days" || die "BACKUP_KEEP_DAYS in $settings must be a number of days."
keep_min=${SWE_BACKUP_KEEP:-3}
[[ "$keep_min" =~ ^[1-9][0-9]*$ ]] || die 'SWE_BACKUP_KEEP must be a positive number.'
recipient=$(conf_get "$settings" BACKUP_AGE_RECIPIENT)
offsite_bucket=$(conf_get "$settings" OFFSITE_BUCKET)
[[ ! -d "$SWE_DIR" ]] || take_lock
SWE_REPO_DIR=$source_dir
# An external bucket keeps the uploads; back it up with your storage provider.
if [[ $objects = 1 && "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_STORAGE)" = external ]]; then
  say 'Uploads are in the external bucket and are not copied; back it up with your storage provider.'
  objects=0
fi
kind=database
[[ $objects = 0 ]] || kind=full
backups="$SWE_CONFIG_DIR/backups"
name=$(date -u +%Y%m%dT%H%M%SZ)
target="$backups/$name"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
offsite=off

# status.json carries no secrets; the app reads it through a read-only mount.
write_status() {
  local encrypted=false
  [[ -z "$recipient" || -n "${3:-}" ]] || encrypted=true
  write_backup_status "$1" "$kind" "$started" "${2:-0}" "$encrypted" "$offsite" "$keep_days" "${3:-}"
}

# Encryption that is on, or requested at setup but never completed, must work
# before anything is written: no plaintext backup is made in its place. The
# refusal is recorded first, so the Operations page shows it.
problem=''
if [[ -n "$recipient" || "$(conf_get "$settings" BACKUP_ENCRYPTION)" = requested ]]; then
  problem=$(backup_encryption_problem "$recipient")
fi
if [[ -n "$problem" ]]; then
  write_status failed 0 "$problem"
  die 'Backups are set to be encrypted, but encryption is not working (age is missing, or no key is saved), so no unencrypted backup was made. Install the "age" package, then turn on encryption in the installer menu (Backups), or turn the encryption request off there.'
fi

on_exit() {
  local status=$?
  [[ $status = 0 ]] && return 0
  rm -rf -- "$target.partial"
  write_status failed || true
  exit "$status"
}
trap on_exit EXIT

umask 077
mkdir -p "$target.partial"
compose exec postgres pg_dump -U swevents -d swevents -Fc > "$target.partial/database.dump"
compose exec postgres pg_restore --list < "$target.partial/database.dump" > /dev/null
tar --exclude=./backups -czf "$target.partial/config.tar.gz" -C "$SWE_CONFIG_DIR" .
if [[ $objects = 1 ]]; then
  compose run --rm --no-deps --volume "$target.partial:/backup" --entrypoint mc storage-init \
    mirror --quiet local/spaceworks-events /backup/objects > /dev/null
fi
conf_get "$SWE_CONFIG_DIR/compose.env" SWE_VERSION > "$target.partial/version"
printf '%s\n' "$kind" > "$target.partial/kind"
# Encrypted backups keep only `version` and `kind` readable; everything else
# goes into backup.tar.age, which only the off-server private key opens.
if [[ -n "$recipient" ]]; then
  # The archive is written into the folder it archives, so it skips itself.
  tar -cf - -C "$target.partial" --exclude=./version --exclude=./kind --exclude=./backup.tar.age . \
    | age --encrypt --recipient "$recipient" > "$target.partial/backup.tar.age"
  find "$target.partial" -mindepth 1 -maxdepth 1 ! -name backup.tar.age ! -name version ! -name kind -exec rm -rf -- {} +
fi
mv "$target.partial" "$target"
say "Backup saved to $target ($(du -sh "$target" | cut -f1))."

# Off-site copy: only encrypted backups leave this server.
if [[ -n "$offsite_bucket" ]]; then
  [[ -n "$recipient" ]] || die 'Off-site copies need encrypted backups. Turn on encryption in the installer menu (Backups).'
  image=$(silo_image)
  offsite=failed
  say "Copying the backup to the off-site bucket $offsite_bucket."
  run_mc --volume "$target:/backup:ro" "$image" mirror --quiet /backup "$(offsite_path)/$name" > /dev/null
  run_mc "$image" stat "$(offsite_path)/$name/backup.tar.age" > /dev/null
  offsite_days=$(conf_get "$settings" OFFSITE_KEEP_DAYS)
  if is_days "${offsite_days:-}"; then
    run_mc "$image" rm --recursive --force --older-than "${offsite_days}d" "$(offsite_path)/" > /dev/null || warn 'Old off-site backups could not be pruned.'
  fi
  offsite=ok
fi

# Retention covers backups made by this script only: a backup goes once it is
# older than BACKUP_KEEP_DAYS and is not among the newest of its kind. Full
# and database-only backups are counted separately, so updates never push out
# the last copy of the uploads, and SWE_BACKUP_PROTECT (a restore's source) is
# never removed.
cutoff=$(date -u -d "-$keep_days days" +%Y%m%dT%H%M%SZ)
full=() database_only=()
while IFS= read -r dir; do
  [[ "$(basename "$dir")" != "$(basename "${SWE_BACKUP_PROTECT:-/}")" ]] || continue
  if [[ -d "$dir/objects" || "$(cat "$dir/kind" 2>/dev/null)" = full ]]; then full+=("$dir"); else database_only+=("$dir"); fi
done < <(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '2*Z' | sort -r)
for dir in "${full[@]:keep_min}" "${database_only[@]:keep_min}"; do
  [[ "$(basename "$dir")" < "$cutoff" ]] || continue
  rm -rf -- "$dir"
done
write_status ok "$(du -sb "$target" | cut -f1)"
trap - EXIT
if [[ -z "$recipient" ]]; then
  say 'It contains every secret, unencrypted. Turn on encryption and off-site copies in the installer menu (Backups).'
elif [[ -z "$offsite_bucket" ]]; then
  say 'It is encrypted. Copy it off this server too, or set up off-site copies in the installer menu (Backups).'
fi
