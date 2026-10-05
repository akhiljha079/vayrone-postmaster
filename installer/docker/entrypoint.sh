#!/bin/sh
# First start: create config, master key and schema (vpm init) against the
# database given in VPM_DB_*; later starts run the requested role.
set -e
VPM="node /opt/vayrone-postmaster/app/vpm.mjs"
if [ ! -f "$VPM_CONFIG" ]; then
  : "${VPM_DB_HOST:?set VPM_DB_HOST}"
  : "${VPM_DB_PASSWORD:?set VPM_DB_PASSWORD}"
  $VPM init --home /opt/vayrone-postmaster --config "$VPM_CONFIG" --data /data --master-key /config/master.key \
    --db-host "$VPM_DB_HOST" --db-port "${VPM_DB_PORT:-3306}" --db-name "${VPM_DB_NAME:-vayrone_postmaster}" \
    --db-user "${VPM_DB_USER:-vpm}" --db-password "$VPM_DB_PASSWORD" \
    --hostname "${VPM_HOSTNAME:-postmaster.local}" --web-port 8443
  # Container ports are above 1024; publish them on the standard host ports.
  printf '{"ports":{"submission":2587,"smtps":2465,"imap":2143,"imaps":2993,"pop3":2110,"pop3s":2995}}\n' > /data/runtime.json
fi
exec $VPM "$@"
