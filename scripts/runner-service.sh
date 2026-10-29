# The deploy runner's systemd service, for install-runner.sh. Sourced, never
# executed. It runs as root, so it never executes, sources or trusts anything
# in the runner's directory, which swe-runner (and so any workflow) can write:
# the unit is written here, and a unit GitHub's svc.sh installed earlier is
# removed only after systemd's own metadata ties it to this runner.
# Needs RUNNER_USER, RUNNER_DIR and repository from the caller.
# shellcheck shell=bash

RUNNER_UNIT=swevents-runner.service
SYSTEMD_UNIT_DIR=/etc/systemd/system

# Same layout as GitHub's service template, started through bash so no file
# mode in the runner's tree matters; it runs as swe-runner only.
write_runner_unit() {
  local unit="$SYSTEMD_UNIT_DIR/$RUNNER_UNIT"
  cat > "$unit.new" <<EOF
[Unit]
Description=Space Works Events deploy runner (GitHub Actions)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/bin/bash $RUNNER_DIR/bin/runsvc.sh
User=$RUNNER_USER
Group=$RUNNER_USER
WorkingDirectory=$RUNNER_DIR
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=5min
Restart=on-failure
RestartSec=30s

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$unit.new"
  mv -f "$unit.new" "$unit"
  systemctl daemon-reload
  systemctl enable "$RUNNER_UNIT" >/dev/null 2>&1
  systemctl restart "$RUNNER_UNIT"
}

remove_runner_unit() {
  systemctl disable --now "$RUNNER_UNIT" >/dev/null 2>&1 || true
  rm -f "$SYSTEMD_UNIT_DIR/$RUNNER_UNIT"
  systemctl daemon-reload
}

# verify_legacy_runner_unit UNIT: the unit file is a regular, root-owned file
# directly in the systemd directory, and systemd runs it as swe-runner from
# this runner's directory. Its name alone proves nothing.
verify_legacy_runner_unit() {
  local unit=$1 path key value fragment='' user='' directory='' exec_start='' program re='path=([^[:space:];]+)'
  path="$SYSTEMD_UNIT_DIR/$unit"
  [[ -f "$path" && ! -L "$path" && "$(stat -c %u -- "$path")" = 0 ]] || return 1
  while IFS='=' read -r key value; do
    case $key in
      FragmentPath) fragment=$value ;;
      User) user=$value ;;
      WorkingDirectory) directory=$value ;;
      ExecStart) exec_start=$value ;;
    esac
  done < <(systemctl show --property=FragmentPath,User,WorkingDirectory,ExecStart -- "$unit")
  [[ "$fragment" = "$path" && "$user" = "$RUNNER_USER" && "$directory" = "$RUNNER_DIR" ]] || return 1
  [[ "$exec_start" =~ $re ]] || return 1
  program=${BASH_REMATCH[1]}
  [[ "$program" = "$RUNNER_DIR/"* && "$program" != *..* ]]
}

# Units svc.sh named actions.runner.<owner>-<repo>.<runner>.service (the
# repository part cut to 45 characters on long names) for this repository.
migrate_legacy_runner_units() {
  local prefix path unit
  prefix="actions.runner.$(printf '%s' "${repository//\//-}" | cut -c1-45)"
  for path in "$SYSTEMD_UNIT_DIR"/actions.runner.*.service; do
    [[ -e "$path" || -L "$path" ]] || continue
    unit=${path##*/}
    [[ "$unit" =~ ^actions\.runner\.[A-Za-z0-9._-]{1,150}\.service$ && "$unit" = "$prefix"* ]] || continue
    if ! verify_legacy_runner_unit "$unit"; then
      die "The service $unit does not match this runner ($RUNNER_USER in $RUNNER_DIR), so it was left alone. Check it, remove it by hand (systemctl disable --now $unit; rm $SYSTEMD_UNIT_DIR/$unit; rm -f $RUNNER_DIR/.service; systemctl daemon-reload), then rerun."
    fi
    systemctl disable --now -- "$unit" >/dev/null 2>&1 || true
    rm -f -- "$path"
    say "Replaced the earlier runner service $unit."
  done
  systemctl daemon-reload
  # svc.sh's marker; the runner refuses to unregister while it exists.
  rm -f -- "$RUNNER_DIR/.service"
}

# Stop the runner, whichever way it was installed.
stop_runner_services() {
  remove_runner_unit
  migrate_legacy_runner_units
}
