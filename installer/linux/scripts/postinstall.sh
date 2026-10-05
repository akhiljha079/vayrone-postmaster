#!/bin/sh
# Vayrone PostMaster: first install creates the database, config and master
# key (vpm init); upgrades only restart the services, which migrate the
# database themselves.
#
# Optional environment (install.sh sets these):
#   VPM_DATA_DIR   mail data folder (default /var/lib/vayrone-postmaster)
#   VPM_WEB_PORT   HTTPS port of the web admin (default 443, 8443 if 443 is taken)
#   VPM_HOSTNAME   server name (default: hostname -f)
set -e
HOME_DIR=/opt/vayrone-postmaster
CONF_DIR=/etc/vayrone-postmaster
CONF=$CONF_DIR/vpm.config.json
DATA=${VPM_DATA_DIR:-/var/lib/vayrone-postmaster}
VPM=$HOME_DIR/bin/vpm
SYSTEMD=0
[ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && SYSTEMD=1

install -d -o root -g vpm -m 0750 "$CONF_DIR"
install -d -o vpm -g vpm -m 0750 "$DATA"
[ "$SYSTEMD" = 1 ] && systemctl daemon-reload

if [ -f "$CONF" ]; then
  echo "Vayrone PostMaster upgraded; restarting services."
  if [ "$SYSTEMD" = 1 ]; then
    systemctl enable --now vayrone-postmaster-updater.path >/dev/null 2>&1 || true
    systemctl try-restart vayrone-postmaster.service vayrone-postmaster-worker.service || true
  fi
  exit 0
fi

# A data folder outside /var/lib must be writable for the sandboxed services.
if [ "$DATA" != /var/lib/vayrone-postmaster ]; then
  for unit in vayrone-postmaster vayrone-postmaster-worker; do
    mkdir -p "/etc/systemd/system/$unit.service.d"
    printf '[Service]\nReadWritePaths=%s\n' "$DATA" > "/etc/systemd/system/$unit.service.d/10-data-path.conf"
  done
  mkdir -p /etc/systemd/system/vayrone-postmaster-updater.path.d
  printf '[Path]\nPathExists=\nPathExists=%s/updates/apply.json\n' "$DATA" > /etc/systemd/system/vayrone-postmaster-updater.path.d/10-data-path.conf
  [ "$SYSTEMD" = 1 ] && systemctl daemon-reload
fi

SOCK=""
for s in /run/mysqld/mysqld.sock /var/run/mysqld/mysqld.sock /var/lib/mysql/mysql.sock /run/mariadb/mariadb.sock; do
  if [ -S "$s" ]; then SOCK=$s; break; fi
done
if [ -z "$SOCK" ]; then
  cat <<MSG

Vayrone PostMaster is installed, but no local MariaDB/MySQL server was found.
Install and start one (apt install mariadb-server / dnf install mariadb-server),
then run:
  sudo vpm init --data $DATA --config $CONF --master-key $CONF_DIR/master.key \\
       --db-socket /run/mysqld/mysqld.sock --db-admin-user root --db-admin-socket /run/mysqld/mysqld.sock
  sudo systemctl enable --now vayrone-postmaster vayrone-postmaster-worker
MSG
  exit 0
fi

PORT=${VPM_WEB_PORT:-443}
if [ -z "$VPM_WEB_PORT" ] && command -v ss >/dev/null 2>&1 && ss -Hltn "sport = :443" 2>/dev/null | grep -q .; then
  PORT=8443
  echo "Port 443 is in use by another program; the web admin uses port 8443."
fi
HOSTNAME_FQDN=${VPM_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}

"$VPM" init --home "$HOME_DIR" --config "$CONF" --data "$DATA" --master-key "$CONF_DIR/master.key" \
  --db-socket "$SOCK" --db-admin-user root --db-admin-socket "$SOCK" \
  --hostname "$HOSTNAME_FQDN" --web-port "$PORT" > "$CONF_DIR/install.log" 2>&1 || {
  cat "$CONF_DIR/install.log"
  echo "Database setup failed; see $CONF_DIR/install.log. Fix it and run the vpm init command again."
  exit 0
}
chmod 0600 "$CONF_DIR/install.log"
chown root:vpm "$CONF" "$CONF_DIR/master.key"
chmod 0640 "$CONF"
chmod 0440 "$CONF_DIR/master.key"
chown -R vpm:vpm "$DATA"

if [ "$SYSTEMD" = 1 ]; then
  systemctl enable --now vayrone-postmaster.service vayrone-postmaster-worker.service vayrone-postmaster-updater.path
fi
URL=$(grep 'Open the setup wizard' "$CONF_DIR/install.log" | sed 's/.*: //')
cat <<MSG

  Vayrone PostMaster by Vayrone Infratech is installed.

  Finish the setup in a browser:
    $URL
  (from another computer use this server's IP address instead of the name;
   show the address again with: sudo vpm setup-token)

MSG
exit 0
