#!/usr/bin/env bash
# Show the installation's release, services, disk and newest backup, then run
# the operator checks. Changes nothing.
set -euo pipefail
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
require_root
load_config_dir
[[ -f "$SWE_CONFIG_DIR/compose.env" ]] || die "No installation configuration in $SWE_CONFIG_DIR."
SWE_REPO_DIR=$source_dir
say "Release: $(conf_get "$SWE_CONFIG_DIR/compose.env" SWE_VERSION) at $(conf_get "$SWE_CONFIG_DIR/compose.env" PUBLIC_ORIGIN)"
say "Free disk: $(free_disk_mb /var/lib/docker) MB"
# No backups directory yet just means no backup yet; any other error is shown,
# and the service checks below still run.
newest=$(newest_backup) || warn "Could not list $SWE_CONFIG_DIR/backups."
say "Newest backup: ${newest:-none yet; run scripts/vps-backup.sh}"
compose ps
compose run --rm --no-deps ops node docker/vps/check.mjs
