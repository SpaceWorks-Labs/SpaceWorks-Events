#!/usr/bin/env bash
# Backup settings, from the installer menu: the nightly schedule, how long
# backups stay on this server, encryption to an off-server age key, and copies
# to an off-site S3 bucket. Settings are saved in $SWE_CONFIG_DIR/backup.env.
# shellcheck disable=SC2154 # ask assigns answers by name
set -euo pipefail
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
require_root
require_tty
load_config_dir
[[ -f "$SWE_CONFIG_DIR/compose.env" ]] || die "No installation configuration in $SWE_CONFIG_DIR."
SWE_REPO_DIR=$source_dir
settings=$(backup_env)
touch "$settings"
chmod 600 "$settings"

while true; do
  days=$(conf_get "$settings" BACKUP_KEEP_DAYS)
  recipient=$(conf_get "$settings" BACKUP_AGE_RECIPIENT)
  bucket=$(conf_get "$settings" OFFSITE_BUCKET)
  # "requested": encryption chosen at setup that never worked; backups are refused meanwhile.
  requested=$(conf_get "$settings" BACKUP_ENCRYPTION)
  if timer_enabled backup; then schedule='every night at about 02:30 UTC'; else schedule='off'; fi
  if [[ -n "$recipient" ]]; then encryption="on ($recipient)"
  elif [[ "$requested" = requested ]]; then encryption='requested but not set up: backups are refused until it is (3)'
  else encryption='off'; fi
  if [[ -n "$bucket" ]]; then offsite="on ($bucket/$(conf_get "$settings" OFFSITE_PREFIX), kept $(conf_get "$settings" OFFSITE_KEEP_DAYS) days)"; else offsite='off'; fi
  cat >/dev/tty <<EOF

Backups
  Schedule:          $schedule
  Kept here:         ${days:-14} days (the newest three of each kind always stay)
  Encryption:        $encryption
  Off-site copies:   $offsite

  1) Turn nightly backups $( [[ $schedule = off ]] && echo on || echo off )
  2) Change how many days backups stay on this server
  3) $( if [[ -n "$recipient" ]]; then echo 'Turn encryption off, or make a new key'
        elif [[ "$requested" = requested ]]; then echo 'Set up the requested encryption, or turn the request off'
        else echo 'Turn on encryption (shows a new key once)'; fi )
  4) $( [[ -n "$bucket" ]] && echo 'Change or turn off off-site copies' || echo 'Set up off-site copies (needs encryption)' )
  5) List off-site backups
  6) Done
EOF
  is_menu() { [[ "$1" =~ ^[1-6]$ ]]; }
  ask choice 'Choose 1-6' 6 is_menu 'Enter a number from 1 to 6.'
  case $choice in
    1)
      has_systemd || die 'Scheduling needs systemd. Run vps-backup.sh from cron instead.'
      if timer_enabled backup; then remove_timer backup; say 'Nightly backups are off.'
      elif [[ "$requested" = requested && -n "$(backup_encryption_problem "$recipient")" ]]; then
        warn 'Set up the requested encryption first (3), or turn the request off there: backups are refused until then.'
      else install_backup_timer; say 'Nightly backups are on.'; fi ;;
    2)
      ask days 'Days to keep backups on this server' "${days:-14}" is_days 'Enter a number of days.'
      conf_set "$settings" BACKUP_KEEP_DAYS "$days" ;;
    3)
      if [[ -z "$recipient" && "$requested" = requested ]] && ! confirm 'Set up the requested encryption now (shows a new key once)?' Y; then
        if confirm 'Turn the encryption request off? New backups would hold every secret unencrypted.' N; then
          conf_unset "$settings" BACKUP_ENCRYPTION
          say 'The encryption request is off; new backups are not encrypted.'
        fi
      elif [[ -n "$recipient" ]] && confirm 'Turn encryption off? New backups would hold every secret unencrypted.' N; then
        [[ -z "$bucket" ]] || die 'Turn off off-site copies first: they are only sent encrypted.'
        conf_unset "$settings" BACKUP_AGE_RECIPIENT
        conf_unset "$settings" BACKUP_ENCRYPTION
        say 'Encryption is off for new backups.'
      elif [[ -z "$recipient" ]] || confirm 'Make a new key? Older backups still need the previous key.' N; then
        ensure_age || die 'age could not be installed from the distribution packages. Install "age", then retry.'
        new_backup_key
        [[ -z "$(backup_encryption_problem "$(conf_get "$settings" BACKUP_AGE_RECIPIENT)")" ]]           || die 'age could not encrypt to the new key. Check the "age" package, then retry.'
        conf_unset "$settings" BACKUP_ENCRYPTION
        say 'Encryption is on. New backups need the key you saved to restore.'
      fi ;;
    4)
      if [[ -n "$bucket" ]] && confirm 'Turn off off-site copies?' N; then
        clear_offsite
        say 'Off-site copies are off. Copies already in the bucket stay there.'
        continue
      fi
      [[ -n "$recipient" ]] || { warn 'Turn on encryption first: off-site copies are only sent encrypted.'; continue; }
      ask_offsite
      save_offsite
      unset offsite_secret
      say 'Checking that the bucket is reachable with that key.'
      if run_mc "$(silo_image)" ls "offsite/$offsite_bucket" > /dev/null; then
        say 'Off-site copies are on; the next backup is copied there.'
      else
        clear_offsite
        warn 'The bucket could not be reached with that key. Nothing was saved.'
      fi ;;
    5)
      [[ -n "$bucket" ]] || { warn 'Off-site copies are not set up.'; continue; }
      run_mc "$(silo_image)" ls "$(offsite_path)/" || warn 'The off-site bucket could not be listed.'
      printf 'Restore one with: vps-restore.sh offsite:<name>\n' >/dev/tty ;;
    6) exit 0 ;;
  esac
done
