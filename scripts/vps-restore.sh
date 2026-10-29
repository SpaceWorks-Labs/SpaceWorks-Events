#!/usr/bin/env bash
# Restore the database, and the uploaded objects when the backup has them, from
# a backup made by vps-backup.sh. This replaces live data: the app, Caddy and
# the scheduler stop until the restore finishes, and a fresh database backup is
# taken first. The configuration archive in the backup is not applied here; on a
# new server restore it before setup (see docs/DEPLOYMENT_VPS.md).
#   vps-restore.sh BACKUP [--identity FILE] [--yes]
# BACKUP is a directory in $SWE_CONFIG_DIR/backups, or offsite:<name> to fetch
# one from the off-site bucket first. An encrypted backup (backup.tar.age) needs
# its age private key: --identity FILE, or paste it when asked.
# shellcheck disable=SC2154 # ask assigns answers by name
set -euo pipefail
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
usage() { die 'Usage: vps-restore.sh BACKUP_DIRECTORY|offsite:NAME [--identity FILE] [--yes]'; }
backup=${1:-}
[[ -n "$backup" ]] || usage
shift
assume_yes=0 identity=''
while (($# > 0)); do
  case "$1" in
    --yes) assume_yes=1 ;;
    --identity) (($# > 1)) || usage; identity=$2; shift ;;
    *) usage ;;
  esac
  shift
done
require_root
load_config_dir
[[ -f "$SWE_CONFIG_DIR/compose.env" ]] || die "No installation configuration in $SWE_CONFIG_DIR."
[[ ! -d "$SWE_DIR" ]] || take_lock
SWE_REPO_DIR=$source_dir
umask 077
# A pasted key and a decrypted copy live under backups/, which the safety backup
# taken before the restore never archives, and are removed on exit.
mkdir -p "$SWE_CONFIG_DIR/backups"
work='' key_file=''
stopped=0
cleanup() {
  local status=$?
  set +e
  [[ -z "$work" ]] || rm -rf -- "$work"
  [[ -z "$key_file" ]] || rm -f -- "$key_file"
  if [[ $status != 0 && $stopped = 1 ]]; then
    warn 'The restore failed; starting the services again.'
    compose up -d >/dev/null 2>&1 || warn 'Start them with scripts/vps-compose.sh up -d.'
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ "$backup" = offsite:* ]]; then
  name=${backup#offsite:}
  [[ "$name" =~ ^2[0-9]{7}T[0-9]{6}Z$ ]] || die 'Name an off-site backup by its time, such as offsite:20261020T023512Z.'
  [[ -n "$(conf_get "$(backup_env)" OFFSITE_BUCKET)" ]] || die 'No off-site bucket is configured.'
  backup="$SWE_CONFIG_DIR/backups/$name"
  if [[ ! -d "$backup" ]]; then
    say "Downloading $name from the off-site bucket."
    mkdir -p "$backup.partial"
    run_mc --volume "$backup.partial:/backup" "$(silo_image)" mirror --quiet "$(offsite_path)/$name" /backup > /dev/null
    mv "$backup.partial" "$backup"
  fi
fi
backup=$(CDPATH='' cd -- "$backup" 2>/dev/null && pwd) || die 'The backup directory does not exist.'
source_backup=$backup
if [[ -f "$backup/backup.tar.age" ]]; then
  command -v age >/dev/null || ensure_age || die 'Restoring an encrypted backup needs age. Install the "age" package and rerun.'
  if [[ -z "$identity" ]]; then
    [[ $assume_yes = 0 ]] || die 'This backup is encrypted; pass its key file with --identity FILE.'
    require_tty
    is_age_key() { [[ "$1" =~ ^AGE-SECRET-KEY-1[A-Z0-9]{58}$ ]]; }
    while true; do
      ask_secret age_key 'Paste the backup encryption key (AGE-SECRET-KEY-..., hidden)'
      is_age_key "$age_key" && break
      printf '  That is not an age secret key.\n' >/dev/tty
    done
    key_file=$(mktemp "$SWE_CONFIG_DIR/backups/.restore-key.XXXXXX")
    printf '%s\n' "$age_key" > "$key_file"
    unset age_key
    identity=$key_file
  fi
  [[ -r "$identity" ]] || die "Cannot read the key file $identity."
  work=$(mktemp -d "$SWE_CONFIG_DIR/backups/.restore.XXXXXX")
  say 'Decrypting the backup.'
  age --decrypt --identity "$identity" < "$backup/backup.tar.age" | tar -xf - -C "$work" \
    || die 'The backup could not be decrypted with that key.'
  cp "$backup/version" "$work/version" 2>/dev/null || true
  backup=$work
fi
[[ -s "$backup/database.dump" ]] || die "$source_backup has no database.dump; choose a backup made by vps-backup.sh."
has_objects=0
[[ ! -d "$backup/objects" ]] || has_objects=1
# Files are put back only into the bundled Silo; an external bucket is the provider's.
[[ "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_STORAGE)" != external ]] || has_objects=0
# The services that serve requests or write to the database, as this installation runs them.
serving=(app worker beat)
[[ "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_CADDY_TLS)" = proxy ]] || serving+=(proxy)
[[ "$(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_LAYOUT)" != split ]] || serving+=(frontend)
if [[ $assume_yes = 0 ]]; then
  require_tty
  {
    printf '\nRestore %s\n' "$source_backup"
    printf '  Backed up from: %s\n' "$(cat "$backup/version" 2>/dev/null || echo 'unknown release')"
    printf '  Database:       replaced with the backup (registrations, accounts, events...)\n'
    if [[ $has_objects = 1 ]]; then printf '  Uploads:        files from the backup are put back; newer files stay\n'
    else printf '  Uploads:        not in this backup; left as they are\n'; fi
    printf 'The site is offline during the restore. A backup of the current database is taken first.\n\n'
  } >/dev/tty
  ask answer 'Type RESTORE to continue' '' is_nonempty
  [[ "$answer" = RESTORE ]] || { say 'Cancelled. Nothing was changed.'; exit 2; }
fi
SWE_BACKUP_PROTECT=$source_backup bash "$SWE_REPO_DIR/scripts/vps-backup.sh" --no-objects
# Stop every application writer before resetting the application schema.
# Reset and restore share one transaction: failure must preserve the live data.
stopped=1
compose stop "${serving[@]}"
say 'Resetting the application schema and restoring the database in one transaction.'
# compose exec supplies -T. Generate SQL fully before connecting: a failed
# pg_restore producer piped into psql could otherwise commit a partial stream.
# Keep the temporary SQL private, inside postgres, and remove it on either exit.
# Recreate PostgreSQL 16 public ownership/ACL defaults (pg_dump assumes them),
# plus init-database.sh's app grants before creating any restored objects.
# The dump retains object ACLs and default privileges; database CONNECT survives.
compose exec postgres sh -eu -c '
  umask 077
  restore_sql=$(mktemp)
  trap '\''rm -f -- "$restore_sql"'\'' EXIT
  pg_restore --clean --if-exists -f - > "$restore_sql"
  psql -U swevents -d swevents -X -v ON_ERROR_STOP=1 --single-transaction \
    -c "DROP SCHEMA public CASCADE;
        CREATE SCHEMA public AUTHORIZATION pg_database_owner;
        GRANT USAGE ON SCHEMA public TO PUBLIC;
        GRANT USAGE ON SCHEMA public TO swevents_app;
        ALTER DEFAULT PRIVILEGES FOR ROLE swevents IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO swevents_app;
        ALTER DEFAULT PRIVILEGES FOR ROLE swevents IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO swevents_app;" \
    -f "$restore_sql"
' < "$backup/database.dump"
if [[ $has_objects = 1 ]]; then
  compose run --rm --no-deps --volume "$backup:/backup:ro" --entrypoint mc storage-init \
    mirror --overwrite --quiet /backup/objects local/spaceworks-events > /dev/null
fi
# Migrations bring an older backup up to this release before the app starts.
compose up -d --wait --wait-timeout 300
compose run --rm --no-deps ops node docker/vps/check.mjs
stopped=0
say 'Restore finished. Sign in and check recent events, registrations and uploads.'
