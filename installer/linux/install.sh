#!/bin/sh
# Vayrone PostMaster — one-line installer for Linux.
#
#   curl -fsSL https://download.vayrone.com/postmaster/install.sh | sudo sh
#   sudo sh install.sh --package ./vayrone-postmaster_0.3.0-1_amd64.deb   (offline)
#
# Supported: Ubuntu 22.04 / 24.04, Debian 12, RHEL / AlmaLinux / Rocky 9.
# Installs MariaDB (if no MySQL/MariaDB is present), the PostMaster package,
# opens the firewall for the mail and web ports, and prints the setup address.
#
# Options:
#   --package FILE    install this .deb/.rpm instead of downloading
#   --channel NAME    stable (default) or beta
#   --data DIR        mail data folder (default /var/lib/vayrone-postmaster)
#   --web-port N      HTTPS port of the web admin (default 443, or 8443 if busy)
#   --no-firewall     do not change firewall rules
set -eu

DOWNLOAD=${VPM_DOWNLOAD:-https://download.vayrone.com/postmaster}
CHANNEL=stable
PACKAGE=""
DATA=""
WEBPORT=""
FIREWALL=1
PORTS="443 8443 587 465 143 993 110 995"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --package) PACKAGE=$2; shift 2 ;;
    --channel) CHANNEL=$2; shift 2 ;;
    --data) DATA=$2; shift 2 ;;
    --web-port) WEBPORT=$2; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "run as root (sudo sh install.sh)"
[ -r /etc/os-release ] || die "cannot detect the Linux distribution"
. /etc/os-release
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) DEB_ARCH=amd64; RPM_ARCH=x86_64 ;;
  aarch64|arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64 ;;
  *) die "unsupported CPU architecture $ARCH" ;;
esac

case "$ID" in
  ubuntu|debian) FAMILY=deb ;;
  rhel|almalinux|rocky|centos|ol) FAMILY=rpm ;;
  *) case "${ID_LIKE:-}" in *debian*) FAMILY=deb ;; *rhel*|*fedora*) FAMILY=rpm ;; *) die "unsupported distribution $ID" ;; esac ;;
esac
case "$ID:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|debian:12|rhel:9*|almalinux:9*|rocky:9*) ;;
  *) say "Warning: $PRETTY_NAME is not a tested platform; continuing" ;;
esac
say "Installing Vayrone PostMaster on $PRETTY_NAME"

# ---------------------------------------------------------------- database
have_db() { command -v mariadbd >/dev/null 2>&1 || command -v mysqld >/dev/null 2>&1 || [ -x /usr/sbin/mariadbd ] || [ -x /usr/sbin/mysqld ] || [ -x /usr/libexec/mysqld ]; }
if [ "$FAMILY" = deb ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  have_db || { say "Installing MariaDB"; apt-get install -y -qq mariadb-server; }
  apt-get install -y -qq curl ca-certificates >/dev/null
else
  have_db || { say "Installing MariaDB"; dnf install -y -q mariadb-server; }
  command -v curl >/dev/null 2>&1 || dnf install -y -q curl
fi
for svc in mariadb mysql mysqld; do
  if systemctl list-unit-files "$svc.service" >/dev/null 2>&1 && systemctl list-unit-files "$svc.service" | grep -q "$svc.service"; then
    systemctl enable --now "$svc.service" >/dev/null 2>&1 && break
  fi
done
i=0
until [ -S /run/mysqld/mysqld.sock ] || [ -S /var/lib/mysql/mysql.sock ] || [ -S /var/run/mysqld/mysqld.sock ]; do
  i=$((i + 1)); [ $i -gt 30 ] && die "MariaDB did not start (check: systemctl status mariadb)"
  sleep 1
done

# ---------------------------------------------------------------- package
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if [ -z "$PACKAGE" ]; then
  BASE="$DOWNLOAD/$CHANNEL"
  VERSION=$(curl -fsSL "$BASE/LATEST") || die "cannot reach $BASE (use --package FILE for offline installs)"
  if [ "$FAMILY" = deb ]; then FILE="vayrone-postmaster_${VERSION}-1_${DEB_ARCH}.deb"; else FILE="vayrone-postmaster-${VERSION}-1.${RPM_ARCH}.rpm"; fi
  say "Downloading $FILE"
  curl -fsSL -o "$TMP/$FILE" "$BASE/$FILE"
  curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"
  (cd "$TMP" && grep " \./$FILE\$\| $FILE\$" SHA256SUMS | sed 's# \./# #' | sha256sum -c --quiet -) || die "checksum mismatch for $FILE"
  PACKAGE="$TMP/$FILE"
fi
[ -f "$PACKAGE" ] || die "package $PACKAGE not found"

say "Installing the package"
export VPM_DATA_DIR="${DATA:-/var/lib/vayrone-postmaster}"
[ -n "$WEBPORT" ] && export VPM_WEB_PORT="$WEBPORT"
if [ "$FAMILY" = deb ]; then
  apt-get install -y "$(readlink -f "$PACKAGE")"
else
  dnf install -y "$(readlink -f "$PACKAGE")"
fi

# ---------------------------------------------------------------- firewall
if [ "$FIREWALL" = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Opening ports in ufw: $PORTS"
    for p in $PORTS; do ufw allow "$p/tcp" >/dev/null; done
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    say "Opening ports in firewalld: $PORTS"
    for p in $PORTS; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
    firewall-cmd --reload >/dev/null
  fi
fi

if systemctl is-active --quiet vayrone-postmaster.service; then
  say "Services are running"
  vpm setup-token || true
else
  say "The service is not running yet: systemctl status vayrone-postmaster"
fi
