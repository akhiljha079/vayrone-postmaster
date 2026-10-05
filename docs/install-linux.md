# Installing Vayrone PostMaster on Linux

For Vayrone and partner technicians, and client IT administrators.

**Supported:** Ubuntu 22.04 and 24.04, Debian 12, RHEL / AlmaLinux / Rocky Linux 9 (x86-64 or ARM64).

## Requirements

Same hardware, network and accounts as on Windows ([install-windows.md](install-windows.md#before-you-start)). Linux-specific points:

- MariaDB (or MySQL 8) on the same server. The installer installs MariaDB when none is present.
- A disk for `/var/lib/vayrone-postmaster`: mount the large SSD there, or choose another folder with `--data`.

## Install with the one-line installer

With internet access:

```sh
curl -fsSL https://download.vayrone.com/postmaster/install.sh | sudo sh
```

Without internet, copy `install.sh` and the package to the server, then:

```sh
sudo sh install.sh --package ./vayrone-postmaster_<version>-1_amd64.deb   # Ubuntu / Debian
sudo sh install.sh --package ./vayrone-postmaster-<version>-1.x86_64.rpm  # RHEL / Alma / Rocky
```

| Option | Effect |
|--------|--------|
| `--data /srv/mail` | Mail data folder (default `/var/lib/vayrone-postmaster`) |
| `--web-port 8443` | HTTPS port of the web admin (default 443; 8443 if 443 is busy) |
| `--channel beta` | Install from the beta channel |
| `--no-firewall` | Do not open ports in ufw or firewalld |

The installer:

1. installs and starts MariaDB if needed;
2. checks the package's SHA-256;
3. installs it;
4. creates the database and its own database account;
5. writes `/etc/vayrone-postmaster/vpm.config.json` and the master key;
6. starts the services;
7. opens ports 443/8443, 587, 465, 143, 993, 110 and 995;
8. prints the **setup wizard address with its token**.

Open that address in a browser and follow the wizard ([install-windows.md](install-windows.md#setup-wizard); the steps are the same). To see the address again: `sudo vpm setup-token`.

## Services

```sh
systemctl status vayrone-postmaster vayrone-postmaster-worker
journalctl -u vayrone-postmaster -f            # mail server and web admin log
journalctl -u vayrone-postmaster-worker -f     # fetching, outgoing queue, backups
```

| Unit | Purpose |
|------|---------|
| `vayrone-postmaster.service` | Mail server (SMTP/IMAP/POP3) and web admin |
| `vayrone-postmaster-worker.service` | External mailbox fetching, outgoing relay queue, backups, licence check |
| `vayrone-postmaster-updater.path` | Starts the updater when an update is installed from the admin panel |

**How the services run:**

- **Account:** the user `vpm`, under systemd sandboxing. The program files are read-only to them, and they can write only to the data folder.
- **Low ports:** binding ports below 1024 uses `CAP_NET_BIND_SERVICE`, not root.

## Files

| Path | Contents |
|------|----------|
| `/opt/vayrone-postmaster` | Program (`bin/vpm`, `db`, `web`) |
| `/etc/vayrone-postmaster/vpm.config.json` | Configuration (database password), `root:vpm 0640` |
| `/etc/vayrone-postmaster/master.key` | Encryption key for stored passwords, `root:vpm 0440`. **Back it up separately**; without it, stored provider passwords cannot be read. |
| `/var/lib/vayrone-postmaster` | Mail, search index, certificates, updates |

## Backups to other folders

The worker may write backups to the data folder and to mounts under `/mnt`, `/media`, `/srv` and `/backup`. For another folder:

```sh
sudo systemctl edit vayrone-postmaster-worker
# add:
[Service]
ReadWritePaths=/your/backup/folder
```

Then run `sudo systemctl restart vayrone-postmaster-worker`.

To back up to a Windows/NAS share, mount it, for example with `/etc/fstab`:

```
//nas/backup  /mnt/nasbackup  cifs  credentials=/etc/vayrone-postmaster/nas.cred,uid=vpm,gid=vpm,_netdev  0 0
```

## Technician commands

Commands run as root switch to the `vpm` account automatically.

```sh
sudo vpm cli help
sudo vpm cli license            # licence status
sudo vpm cli folders user@company.com
sudo vpm setup-token
```

## Removing

```sh
sudo apt remove vayrone-postmaster     # or: sudo dnf remove vayrone-postmaster
```

This stops and removes the services and program. **Mail, the database, `/etc/vayrone-postmaster` and the master key are kept.**

## Docker (optional)

See [installer/README.md](../installer/README.md#docker-installerdocker-optional). In Docker, updates are done by pulling a new image rather than through the admin panel.
