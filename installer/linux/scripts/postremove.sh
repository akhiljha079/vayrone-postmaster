#!/bin/sh
# Mail is never deleted by the package manager. Purge removes the
# configuration only; the data folder and database stay until removed by hand.
set -e
case "$1" in
  purge)
    rm -rf /etc/systemd/system/vayrone-postmaster.service.d /etc/systemd/system/vayrone-postmaster-worker.service.d /etc/systemd/system/vayrone-postmaster-updater.path.d
    rm -rf /run/vayrone-postmaster
    echo "Vayrone PostMaster removed. Mail data in /var/lib/vayrone-postmaster and the database were kept;"
    echo "the configuration and master key in /etc/vayrone-postmaster were kept too (needed to read stored passwords)."
    ;;
esac
[ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload || true
exit 0
