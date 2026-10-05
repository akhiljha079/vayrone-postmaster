#!/bin/sh
# Vayrone PostMaster: service account before files are unpacked.
set -e
getent group vpm >/dev/null 2>&1 || groupadd --system vpm
getent passwd vpm >/dev/null 2>&1 || useradd --system --gid vpm --home-dir /var/lib/vayrone-postmaster --no-create-home --shell /usr/sbin/nologin --comment "Vayrone PostMaster" vpm
exit 0
