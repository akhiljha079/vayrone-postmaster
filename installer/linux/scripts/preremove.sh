#!/bin/sh
# Stop the services on removal, not on upgrade (deb: "remove", rpm: 0).
set -e
case "$1" in
  remove|0)
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now vayrone-postmaster-updater.path vayrone-postmaster.service vayrone-postmaster-worker.service >/dev/null 2>&1 || true
    fi
    ;;
esac
exit 0
