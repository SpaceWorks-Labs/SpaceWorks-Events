#!/usr/bin/env bash
# Space Works Events VPS installer:
#   curl -fsSL https://raw.githubusercontent.com/SpaceWorks-Labs/SpaceWorks-Events/main/install.sh | bash
# Installs the latest GitHub Release (or --release TAG) with its published
# container images, or builds a branch or commit from source with --ref. It
# downloads that source into temporary storage and runs its guided setup, which
# asks every question first and changes nothing until you confirm. Run it again
# to update, back up or check the installation. It is fetched alone, so it is
# self-contained.
set -euo pipefail
set +x

show_guide() {
  cat <<'EOF'

Space Works Events installer - the whole event platform on one Linux server.

What you need
  - A 64-bit (x86_64 or arm64) Linux server: Ubuntu/Debian, Fedora/RHEL/Alma/Rocky,
    Arch or openSUSE, with 2 GB memory (swap is offered on smaller plans; a
    source build with --ref needs 4 GB) and at least 10 GB free disk.
  - root, or a user with sudo. Docker and Docker Compose are installed if missing.
  - A hostname whose DNS A record points at this server, with ports 80 and 443 open.
  - An SMTP relay on a verified sending domain (Brevo, Amazon SES, Postmark...).
  - Your super-admin email address.

What it does
  1. Checks this server and downloads the latest release into temporary storage.
  2. Asks every question, shows a summary and waits for your confirmation.
  3. Installs to /opt/spaceworks-events with secrets in /etc/spaceworks-events,
     downloads the release's backend and frontend images from GitHub Packages
     and starts them with PostgreSQL, Redis, Silo object storage and Caddy
     HTTPS. The backend image also runs the migrations, the email worker and the beat.
  4. Optionally: nightly encrypted backups with off-site copies, a firewall,
     automatic security updates and automatic deploys of new releases.
  Run the same command later to update, back up, check, change settings,
  recover super-admin access, collect a support bundle or uninstall.

Options
  --release TAG install or update to this release (default: the latest release)
  --ref REF     build a branch, tag or commit from source instead of a release
  --repo O/N    install from a fork (default: SpaceWorks-Labs/SpaceWorks-Events)
  --dir PATH    installation directory (default: /opt/spaceworks-events)
  --update      update an existing installation without the menu
  --help        show this guide and exit
EOF
}

say() { printf '[Space Works Events] %s\n' "$*"; }
die() { printf '[Space Works Events] ERROR: %s\n' "$*" >&2; exit 1; }
usage() { die 'Usage: install.sh [--release TAG | --ref REF] [--repo OWNER/NAME] [--dir PATH] [--update] [--help]'; }
as_root() { ${SUDO[@]+"${SUDO[@]}"} "$@"; }
# Children never read the curl pipe: their questions come from the terminal.
run_root() { as_root "${RUN_ENV[@]}" "$@" </dev/null; }
prompt() {
  local reply
  printf '%s' "$1" >/dev/tty
  IFS= read -r reply </dev/tty || reply=''
  printf '%s' "${reply%$'\r'}"
}
conf_get() {
  as_root sed -n "s/^$2=//p" "$1/install.conf" 2>/dev/null | tail -n 1 | tr -d "'\r" || true
}
# run_tool SCRIPT [ARGS...]: a menu entry, run from the installed release, then exit.
run_tool() {
  as_root test -f "$INSTALL_DIR/current/scripts/$1" \
    || die "This release predates that option. Update first (option 1), then run the installer again."
  local status=0
  run_root bash "$INSTALL_DIR/current/scripts/$1" "${@:2}" || status=$?
  # 2 is a cancellation at a prompt; it already said so.
  [[ $status = 0 || $status = 2 ]] || exit "$status"
  exit 0
}
github() { curl --fail --silent --show-error --location --proto '=https' "$@"; }
commit_of() {
  github --header 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$1/commits/$2"
}

# Everything runs from main, so under `curl | bash` the whole script has been
# read before any child process could consume the rest of the pipe.
main() {
  local repository=${SWE_REPOSITORY:-} ref=${SWE_REF:-} release=${SWE_RELEASE_TAG:-} install_dir=${SWE_DIR:-/opt/spaceworks-events}
  local action='' installed='' installed_version='' pending='' config_dir='' choice='' revision='' version='' status=0 file=''
  while (($# > 0)); do
    case "$1" in
      -h|--help) show_guide; exit 0 ;;
      --ref) (($# > 1)) || usage; ref=$2; shift ;;
      --ref=*) ref=${1#--ref=} ;;
      --release) (($# > 1)) || usage; release=$2; shift ;;
      --release=*) release=${1#--release=} ;;
      --repo) (($# > 1)) || usage; repository=$2; shift ;;
      --repo=*) repository=${1#--repo=} ;;
      --dir) (($# > 1)) || usage; install_dir=$2; shift ;;
      --dir=*) install_dir=${1#--dir=} ;;
      --update) action=update ;;
      *) usage ;;
    esac
    shift
  done
  [[ -z "$ref" || -z "$release" ]] || die 'Choose either --release or --ref, not both.'
  [[ -z "$ref" || ( "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,150}$ && "$ref" != *..* ) ]] || die 'Invalid source reference.'
  [[ -z "$release" || "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[a-z0-9-]+\.[0-9]+\.[0-9a-f]{12}$ ]] || die 'Invalid release tag.'
  install_dir=${install_dir%/}
  [[ "$install_dir" = /* && -n "${install_dir#/}" && "$install_dir" != *[[:space:]:\'\"]* ]] \
    || die 'Use an absolute installation directory without spaces, quotes or colons.'
  INSTALL_DIR=$install_dir
  if [[ -n "${SWE_CONFIG_DIR:-}" ]]; then
    [[ "$SWE_CONFIG_DIR" = /* && "$SWE_CONFIG_DIR" != / && "$SWE_CONFIG_DIR" != *[[:space:]:\'\"]* ]] \
      || die 'SWE_CONFIG_DIR must be an absolute path without spaces, quotes or colons.'
  fi

  show_guide
  [[ $(uname -s) = Linux ]] || die 'Run this on the Linux server that will host Space Works Events.'
  case $(uname -m) in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "Unsupported architecture $(uname -m); use an x86_64 or arm64 server." ;;
  esac
  for file in curl tar; do
    command -v "$file" >/dev/null || die "Install $file first, then rerun."
  done
  { : </dev/tty; } 2>/dev/null || die 'An interactive terminal is required (for SSH, use ssh -t).'
  SUDO=()
  if [[ $(id -u) != 0 ]]; then
    command -v sudo >/dev/null || die 'Run this as root, or install sudo.'
    SUDO=(sudo)
    say 'Installation steps run as root; sudo may ask for your password.'
  fi

  if as_root test -L "$install_dir/current"; then
    installed=$(basename "$(as_root readlink -f "$install_dir/current")")
    # compose.env records what actually runs (a failed update leaves it unchanged).
    config_dir=${SWE_CONFIG_DIR:-$(conf_get "$install_dir" SWE_CONFIG_DIR)}
    installed_version=$(as_root sed -n "s/^SWE_VERSION=//p" "${config_dir:-/etc/spaceworks-events}/compose.env" 2>/dev/null \
      | tail -n 1 | tr -d "'\r" || true)
    installed_version=${installed_version:-vps-${installed:0:12}}
  fi
  if as_root test -f "$install_dir/install.conf"; then pending=$(conf_get "$install_dir" SWE_PENDING_RELEASE); fi
  repository=${repository:-$(conf_get "$install_dir" SWE_REPOSITORY)}
  # A fresh install asks once, so a fork installs without knowing --repo.
  if [[ -z "$repository" && -z "$installed" && -z "$pending" && "$action" != update ]]; then
    repository=$(prompt "
Install from which GitHub repository? Press Enter for the official one.
Repository [SpaceWorks-Labs/SpaceWorks-Events]: ")
  fi
  repository=${repository:-SpaceWorks-Labs/SpaceWorks-Events}
  [[ "$repository" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$ && "$repository" != */. && "$repository" != */.. ]] \
    || die 'The repository must be a GitHub owner/name.'
  RUN_ENV=(env "SWE_DIR=$install_dir" "SWE_REPOSITORY=$repository")
  [[ -z "${SWE_CONFIG_DIR:-}" ]] || RUN_ENV+=("SWE_CONFIG_DIR=$SWE_CONFIG_DIR")
  # LAN and test installs whose hostnames are not public: Caddy's local CA.
  [[ "${SWE_CADDY_TLS:-}" != internal ]] || RUN_ENV+=(SWE_CADDY_TLS=internal)

  if [[ -n "$installed" ]]; then
    if [[ -z "$action" ]]; then
      choice=$(prompt "
Space Works Events $installed_version is installed in $install_dir.
What do you want to do?
  1) Update to the latest release - backs up the database first, keeps your settings and data
  2) Back up now - database, configuration and uploads
  3) Check status and health
  4) Backups - nightly schedule, encryption and off-site copies
  5) Change settings - hostnames, outgoing email or bucket credentials
  6) Server security - firewall, automatic security updates and fail2ban
  7) Automatic deploys - install or remove the GitHub Actions runner
  8) Recover super-admin access - lost authenticator or password
  9) Support bundle - collect checks and logs for troubleshooting
  10) Uninstall
  0) Cancel - change nothing
Choose 0-10 [0]: ")
      case "${choice:-0}" in
        1) action=update ;;
        2) run_tool vps-backup.sh ;;
        3) run_tool vps-status.sh ;;
        4) run_tool vps-backup-settings.sh ;;
        5) run_tool vps-reconfigure.sh ;;
        6) run_tool vps-harden.sh ;;
        7)
          choice=$(prompt "Install or re-register the runner (i), or remove it (r)? [i]: ")
          case "${choice:-i}" in
            i|I) run_tool install-runner.sh ;;
            r|R) run_tool install-runner.sh --remove ;;
            *) die 'Invalid choice. Nothing was changed.' ;;
          esac ;;
        8) run_tool vps-recover.sh ;;
        9) run_tool vps-support.sh ;;
        10) run_tool vps-uninstall.sh ;;
        0) say 'Cancelled. Nothing was changed.'; exit 0 ;;
        *) die 'Invalid choice. Nothing was changed.' ;;
      esac
    fi
  elif [[ -n "$pending" ]]; then
    if ! [[ "$pending" =~ ^[a-f0-9]{40}$ ]] || ! as_root test -f "$install_dir/releases/$pending/scripts/setup-vps.sh"; then
      die "$install_dir/install.conf names an unfinished release that is missing. Repair it by hand."
    fi
    config_dir=${SWE_CONFIG_DIR:-$(conf_get "$install_dir" SWE_CONFIG_DIR)}
    if as_root test -f "${config_dir:-/etc/spaceworks-events}/compose.env"; then
      choice=$(prompt "
A previous setup of commit ${pending:0:12} in $install_dir did not finish; its secrets exist.
  1) Resume - start it, keeping those secrets
  2) Cancel - change nothing
Choose 1-2 [1]: ")
      case "${choice:-1}" in
        1) run_root bash "$install_dir/releases/$pending/scripts/setup-vps.sh" --resume; exit 0 ;;
        2) say 'Cancelled. Nothing was changed.'; exit 0 ;;
        *) die 'Invalid choice. Nothing was changed.' ;;
      esac
    fi
    choice=$(prompt "
A previous setup of commit ${pending:0:12} in $install_dir stopped before generating secrets.
  1) Continue it - answer the questions again for that commit
  2) Start over - remove the unfinished copy and download again
  3) Cancel - change nothing
Choose 1-3 [1]: ")
    case "${choice:-1}" in
      1) run_root bash "$install_dir/releases/$pending/scripts/setup-vps.sh" --resume; exit 0 ;;
      2) as_root rm -rf -- "$install_dir/releases" "$install_dir/install.conf"; action=install ;;
      3) say 'Cancelled. Nothing was changed.'; exit 0 ;;
      *) die 'Invalid choice. Nothing was changed.' ;;
    esac
  else
    [[ "$action" != update ]] || die "There is no installation in $install_dir to update."
    if as_root test -e "$install_dir" && [[ -n "$(as_root find "$install_dir" -mindepth 1 -maxdepth 1 ! -name .lock -print -quit)" ]]; then
      die "$install_dir has files but no installation record. Choose another --dir or empty it first."
    fi
    action=install
  fi

  if [[ -n "$ref" ]]; then
    say "Resolving $ref in $repository; it will be built from source on this server."
    revision=$(commit_of "$repository" "$ref") || die "Could not find $ref in $repository on GitHub."
    version="vps-${revision:0:12}"
  else
    if [[ -z "$release" ]]; then
      say "Finding the latest release of $repository."
      release=$(github "https://api.github.com/repos/$repository/releases/latest" \
        | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) \
        || die "$repository has no published release yet. Install from source with --ref main."
      [[ "$release" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-[a-z0-9-]+\.[0-9]+\.[0-9a-f]{12}$ ]] \
        || die "Unexpected latest release '${release:-none}' in $repository. Install from source with --ref main."
    fi
    version=${release#v}
    revision=$(commit_of "$repository" "$release") || die "Could not find release $release in $repository."
    [[ "${revision:0:12}" = "${version: -12}" ]] || die "Release $release does not point at its own commit."
  fi
  [[ "$revision" =~ ^[a-f0-9]{40}$ ]] || die 'GitHub returned an unexpected commit id.'
  if [[ "$action" = update && "$version" = "$installed_version" ]]; then
    say "Already on $version. Nothing to update."
    exit 0
  fi
  # Root runs the staged scripts, so only root may write the staging directory.
  STAGE=$(as_root mktemp -d)
  trap 'as_root rm -rf -- "$STAGE"' EXIT
  say "Downloading $version (commit ${revision:0:12}) into temporary storage."
  as_root curl --fail --silent --show-error --location --proto '=https' \
    "https://codeload.github.com/$repository/tar.gz/$revision" -o "$STAGE/source.tar.gz"
  as_root mkdir "$STAGE/source"
  as_root tar -xzf "$STAGE/source.tar.gz" -C "$STAGE/source" --strip-components=1 --no-same-owner
  as_root rm -f "$STAGE/source.tar.gz"
  printf '%s\n' "$revision" | as_root tee "$STAGE/source/.release" >/dev/null
  # Marks a published release: setup and updates pull its images instead of building.
  if [[ -z "$ref" ]]; then printf '%s\n' "$version" | as_root tee "$STAGE/source/.release-version" >/dev/null; fi
  for file in scripts/vps-lib.sh scripts/setup-vps.sh scripts/update-vps.sh scripts/vps-compose.sh compose.production.yml; do
    as_root test -f "$STAGE/source/$file" || die "Commit ${revision:0:12} has no $file; it predates this installer."
  done
  RUN_ENV+=(SWE_STAGED=1)
  if [[ "$action" = update ]]; then
    run_root bash "$STAGE/source/scripts/update-vps.sh" || status=$?
  else
    run_root bash "$STAGE/source/scripts/setup-vps.sh" || status=$?
  fi
  # 2 is a cancellation at the confirmation prompt; it already said so.
  [[ $status = 0 || $status = 2 ]] || die "Stopped with an error (exit $status). Fix the cause above, then run the installer again."
}

main "$@"
