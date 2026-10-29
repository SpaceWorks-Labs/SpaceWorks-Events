#!/usr/bin/env bash
# Automatic deploys, as SpaceWorks does them (explicit opt-in): installs GitHub's
# official Actions runner as a systemd service with the label
# spaceworks-events-prod. When a release is published, the Release workflow's
# deploy job runs `sudo /usr/local/sbin/swevents-deploy v<version>` here; nothing
# connects in from GitHub.
#   install-runner.sh           install or re-register the runner
#   install-runner.sh --remove  unregister it and remove the service
# A repository-level runner accepts any workflow that names its label, so it
# runs as the unprivileged account swe-runner, without Docker access. Its only
# root command is the deploy wrapper, which installs verified, published main
# releases and nothing else. As root, this script never runs anything from the
# runner's directory: the service is a unit written here (runner-service.sh),
# the runner's files are unpacked as swe-runner, and its system dependencies
# are installed from a fresh root-owned extraction of the verified archive.
set -euo pipefail
# Tokens must stay out of shell traces, argv, answer files and the runner's .env.
set +x
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=scripts/vps-lib.sh
. "$source_dir/scripts/vps-lib.sh"
# shellcheck source=scripts/runner-service.sh
. "$source_dir/scripts/runner-service.sh"
mode=install
case "${1:-}" in
  '') ;;
  --remove) mode=remove ;;
  *) die 'Usage: install-runner.sh [--remove]' ;;
esac
[[ $# -le 1 ]] || die 'Usage: install-runner.sh [--remove]'
require_root
require_tty
if [[ "$(uname -s)" != Linux ]] || ! command -v systemctl >/dev/null || [[ ! -d /run/systemd/system ]]; then
  die 'Automatic deploys need Linux with systemd running.'
fi
[[ -f "$(install_conf)" && -L "$SWE_DIR/current" ]] \
  || die "Automatic deploys need an installation made by the one-line installer in $SWE_DIR."
RUNNER_USER=swe-runner
RUNNER_HOME=/var/lib/swe-runner
RUNNER_DIR=${SWE_RUNNER_DIR:-/opt/spaceworks-events-runner}
WRAPPER=/usr/local/sbin/swevents-deploy
SUDOERS=/etc/sudoers.d/spaceworks-events-deploy
is_safe_path "$RUNNER_DIR" && [[ "$RUNNER_DIR" != "$SWE_DIR" && ! -L "$RUNNER_DIR" ]] || die 'Use a dedicated absolute runner directory.'
repository=${SWE_REPOSITORY:-$(conf_get "$(install_conf)" SWE_REPOSITORY)}
repository=${repository:-$SWE_DEFAULT_REPOSITORY}
is_repository "$repository" || die 'SWE_REPOSITORY must be a GitHub owner/name.'
if [[ $mode = remove && ! -f "$RUNNER_DIR/.runner" ]]; then
  stop_runner_services
  rm -f "$SUDOERS" "$WRAPPER"
  say 'No configured runner to remove.'
  exit 0
fi

runner_token=''
read_token() {
  local purpose=$1
  printf '\nIn https://github.com/%s: Settings -> Actions -> Runners.\n' "$repository" >/dev/tty
  if [[ $purpose = registration ]]; then
    printf 'Choose New self-hosted runner and copy the short-lived token from its config.sh command.\n' >/dev/tty
  else
    printf 'Select this runner -> Remove and copy the short-lived removal token.\n' >/dev/tty
  fi
  printf '%s token (hidden): ' "$purpose" >/dev/tty
  IFS= read -r -s runner_token </dev/tty || die 'A terminal and token are required.'
  runner_token=${runner_token%$'\r'}
  printf '\n' >/dev/tty
  [[ "$runner_token" =~ ^[A-Za-z0-9_-]+$ ]] || die 'A non-empty GitHub runner token is required.'
}
configure_runner() (
  # The runner's supported secret-input variable: masked and consumed by config.sh.
  export ACTIONS_RUNNER_INPUT_TOKEN="$runner_token" HOME="$RUNNER_HOME"
  cd "$RUNNER_DIR"
  runuser -m -u "$RUNNER_USER" -- bash ./config.sh "$@"
)
unregister() {
  read_token removal
  stop_runner_services
  configure_runner remove
  runner_token=''
}

if [[ $mode = remove ]]; then
  unregister
  rm -f "$SUDOERS" "$WRAPPER"
  say 'Runner registration, service and deploy permission removed; its files were kept. Delete the SWE_DEPLOY variable on GitHub too.'
  exit 0
fi

command -v python3 >/dev/null || install_packages python3
command -v sudo >/dev/null || install_packages sudo
for binary in curl tar sha256sum python3 sudo runuser; do
  command -v "$binary" >/dev/null || die "Missing $binary. Install it, then rerun."
done
case $(uname -m) in
  x86_64|amd64) architecture=x64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) die 'The runner supports only Linux x64 and arm64.' ;;
esac
temporary=$(mktemp -d)
trap 'runner_token=""; rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 \
  https://api.github.com/repos/actions/runner/releases/latest -o "$temporary/release.json"
selection=$(python3 "$source_dir/scripts/runner-release.py" "$architecture" < "$temporary/release.json") \
  || die 'Could not verify the official runner release metadata.'
url=${selection%%$'\n'*}
checksum=${selection##*$'\n'}
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 \
  "$url" -o "$temporary/runner.tar.gz"
printf '%s  %s\n' "$checksum" "$temporary/runner.tar.gz" | sha256sum --check --status \
  || die 'Runner SHA-256 mismatch; nothing was unpacked or registered.'
# An account with no Docker group and no other sudo rights.
id "$RUNNER_USER" >/dev/null 2>&1 \
  || useradd --system --home-dir "$RUNNER_HOME" --create-home --shell /bin/bash "$RUNNER_USER"
if id -nG "$RUNNER_USER" | tr ' ' '\n' | grep -qx docker; then
  die "$RUNNER_USER must not be in the docker group (it would be root). Remove it, then rerun."
fi
install -d -m 0700 -o "$RUNNER_USER" -g "$RUNNER_USER" "$RUNNER_DIR"
if [[ -f "$RUNNER_DIR/.runner" ]]; then
  say 'Re-registering replaces the existing registration, which needs its removal token first.'
  unregister
else
  stop_runner_services
fi
read_token registration
# System packages the runner needs, installed by the archive's own script from a
# fresh root-owned copy, never from the runner-writable directory.
install -d -m 0700 "$temporary/archive"
tar -xzf "$temporary/runner.tar.gz" --no-same-owner -C "$temporary/archive"
[[ -f "$temporary/archive/config.sh" && -f "$temporary/archive/bin/runsvc.sh" ]] || die 'The official runner archive is incomplete.'
[[ ! -f "$temporary/archive/bin/installdependencies.sh" ]] || bash "$temporary/archive/bin/installdependencies.sh" >/dev/null
# Unpacked as the runner account, so root never writes into its directory.
runuser -u "$RUNNER_USER" -- tar -xzf - -C "$RUNNER_DIR" < "$temporary/runner.tar.gz"
# The archive resets the directory mode; the registration credentials live here.
chmod 0700 "$RUNNER_DIR"
configure_runner --url "https://github.com/$repository" --name "$(hostname)-spaceworks-events" \
  --labels spaceworks-events-prod --unattended --replace
runner_token=''

# The single root command the runner may run: deploy a verified published release.
cat > "$WRAPPER.new" <<EOF
#!/bin/sh
# Installed by install-runner.sh. The GitHub Actions deploy job runs this through
# sudo; vps-deploy.sh accepts only published, non-pre-release releases on main.
exec /usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
  SWE_DIR='$SWE_DIR' /bin/bash '$SWE_DIR/current/scripts/vps-deploy.sh' "\$@"
EOF
chown 0:0 "$WRAPPER.new"
chmod 0755 "$WRAPPER.new"
mv -f "$WRAPPER.new" "$WRAPPER"
printf '%s ALL=(root) NOPASSWD: %s\n' "$RUNNER_USER" "$WRAPPER" > "$SUDOERS.new"
chmod 0440 "$SUDOERS.new"
if command -v visudo >/dev/null; then visudo -cqf "$SUDOERS.new" || { rm -f "$SUDOERS.new"; die 'The sudoers rule did not validate.'; }; fi
mv -f "$SUDOERS.new" "$SUDOERS"

write_runner_unit
cat <<EOF

Runner installed as the systemd service $RUNNER_UNIT, running as $RUNNER_USER. Finish in GitHub repository $repository:
1. Settings -> Secrets and variables -> Actions -> Variables -> New repository variable:
   SWE_DEPLOY = true
2. Settings -> Environments -> New environment "production" -> Deployment branches and
   tags: Selected branches -> main (optionally add required reviewers).
3. Settings -> Actions -> General -> Fork pull request workflows:
   Require approval for all external contributors.
4. Settings -> Actions -> Runners: this runner is Idle with the label spaceworks-events-prod.
From then on, every published release (a VERSION bump reaching main) deploys here: a
backup, the update, health checks, and the previous release restored if it fails.
SECURITY: a repository runner accepts any workflow that names its label, so anyone who can
push workflows can run code here as $RUNNER_USER. That account has no Docker access and can
run only $WRAPPER as root, which installs only published, non-pre-release releases on main.
Keep repository write access to trusted maintainers. Runner updates stay automatic.
Remove it with the installer's menu (4) or: sudo bash $SWE_DIR/current/scripts/install-runner.sh --remove
EOF
