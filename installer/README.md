# /installer — Windows and Linux packages

Every package installs the same release folder, built by `scripts/build-release.mjs` on its own platform (CI: `.github/workflows/release.yml`):

| Path | Contents |
|------|----------|
| `bin/vpm(.exe)` | One executable: Node.js 24 plus the server compiled to V8 bytecode. No source; the licensing code is obfuscated. |
| `db/` | Migrations and `schema.sql`. |
| `web/` | Built SPA. |
| `integrity.vsig` | Signed SHA-256 list of every file (release builds). |
| `LEGAL.txt`, `THIRD_PARTY_LICENSES.md`, `NODEJS-LICENSE.txt` | Licence notices. |

`--format node` produces `app/vpm.mjs` plus `runtime/` instead; it is for Docker and for cross-builds during development.

The executable runs in several roles:

| Command | What it runs |
|---------|--------------|
| `vpm core` | Mail server and web admin |
| `vpm worker` | Fetching, relay queue, backups, licence check-in, monitoring |
| `vpm all` | Both roles in one process |
| `vpm update-apply` / `vpm updater` | Privileged updater (Linux path unit / Windows service) |
| `vpm init` | First-install step run by the installers |
| `vpm setup-token` | Prints the setup wizard address |
| `vpm cli …` | Technician commands |

A process that exits with code 75 is asking to be restarted (for example after the setup wizard changes ports or the TLS certificate). Both service managers are configured to restart it.

---

## Windows (`windows/`)

**Supported:** Windows 10/11 and Windows Server 2016 or later, 64-bit.

### Build

Run `node scripts/package-windows.mjs`. It:

1. builds `release\win-x64`;
2. downloads WinSW 2.12.0;
3. downloads MariaDB 11.4 LTS from archive.mariadb.org and checks it against mariadb.org's SHA-256, then keeps only the server, installer and client tools;
4. on Windows with Inno Setup 6, compiles `dist\VayronePostMaster-Setup-<version>.exe`.

On macOS or Linux it stops after step 3. Then run `ISCC /DAppVersion=<version> installer\windows\vayrone-postmaster.iss` on a Windows build machine.

### What the installer does

| Item | Location / value |
|------|------------------|
| Program | `C:\Program Files\Vayrone PostMaster` |
| Config and encryption key | `C:\ProgramData\Vayrone PostMaster` (`vpm.config.json`, `master.key.dpapi`, `mariadb-root.txt`, `install.log`) |
| Mail data | Chosen on a wizard page (default `C:\ProgramData\Vayrone PostMaster\data`) |
| Web admin port | Chosen on a wizard page: 443, or 8443 when IIS or another program already uses 443 |

On a first install it then:

1. **Database:** initialises the bundled MariaDB in `<data>\db` as service **VayronePostMasterDB**, listening on 127.0.0.1:3307 only.
   - The root password is random; it is kept in `mariadb-root.txt` (Administrators only).
2. **`vpm init`:** creates the database and its own DB user, writes the config, creates the master key (Windows DPAPI, machine scope), loads the schema and issues the setup token.
3. **File permissions:** the data and config folders are restricted to Administrators and SYSTEM.
4. **Services:** registers **Vayrone PostMaster**, **Vayrone PostMaster Worker** and **Vayrone PostMaster Updater** (WinSW, automatic start, restart on failure, logs in `<data>\logs`).
5. **Firewall:** opens the web port and 587, 465, 143, 993, 110, 995 for the domain/private profiles.
6. **Start menu:** adds "Vayrone PostMaster admin", "Show setup wizard address", a command prompt, licences and uninstall.
7. **Setup wizard:** opens `https://localhost:<port>/setup`. On the server itself no token is needed.

### Upgrades and removal

- **Upgrade:** run the new setup. It stops the two program services, replaces the program files and starts the services again. They migrate the database themselves. The MariaDB files and data are not touched.
- **Uninstall:** removes the services and the firewall rule. **Mail data, database and config are kept.** Delete them by hand only when the mail is no longer needed.

---

## Linux (`linux/`)

**Supported:** Ubuntu 22.04 / 24.04, Debian 12, RHEL / AlmaLinux / Rocky 9 (x64; arm64 builds with `ARCH=arm64`).

### Build

Run `sh scripts/package-linux.sh` (needs [nfpm](https://github.com/goreleaser/nfpm/releases) on PATH). It writes:

- `dist/vayrone-postmaster_<ver>-1_amd64.deb`
- `dist/vayrone-postmaster-<ver>-1.x86_64.rpm`
- `install.sh`, `SHA256SUMS` and `LATEST`, for the download server

### Install

```sh
curl -fsSL https://download.vayrone.com/postmaster/install.sh | sudo sh   # online
sudo sh install.sh --package ./vayrone-postmaster_0.3.0-1_amd64.deb      # offline
```

`install.sh` installs and starts MariaDB if needed, installs the package, opens the ports in ufw/firewalld, and prints the setup wizard address.

| Option | Effect |
|--------|--------|
| `--data DIR` | Mail data folder |
| `--web-port N` | HTTPS port of the web admin |
| `--channel beta` | Install from the beta channel |
| `--no-firewall` | Leave firewall rules unchanged |

### What the package does

**Files:**

| Path | Contents |
|------|----------|
| `/opt/vayrone-postmaster` | Program |
| `/usr/bin/vpm` | Launcher |
| `/etc/vayrone-postmaster` | Config + `master.key`; `root:vpm`, modes 0640/0440 |
| `/var/lib/vayrone-postmaster` | Data; `vpm:vpm` 0750 |

**Services:** `vayrone-postmaster` and `vayrone-postmaster-worker`. Both run as the system user `vpm`, with systemd sandboxing (`ProtectSystem=strict`, private /tmp, no new privileges). Core gets `CAP_NET_BIND_SERVICE` for ports below 1024.

**Before each start**, a root step (`vpm hwid --write /run/vayrone-postmaster/hwid`) records the root-only hardware serials for the licence fingerprint.

**First install:** `vpm init` runs as root through MariaDB's unix-socket root login, creating the database and a dedicated user with a random password.

**Upgrades:** the services restart; they migrate the database themselves.

**Removal and purge:** remove stops and disables the services. Purge also keeps the mail data and the database; only the systemd drop-ins are removed.

**Running `vpm` as root:** commands are re-run as user `vpm` (except `init` and `hwid`), so the files they create stay usable by the services.

**Backup folders:** the worker can write to the data folder and to anything under `/mnt`, `/media`, `/srv` or `/backup`. For another folder, add a drop-in:

```sh
sudo systemctl edit vayrone-postmaster-worker
#   [Service]
#   ReadWritePaths=/your/backup/folder
```

---

## Docker (`docker/`, optional)

```sh
node scripts/build-release.mjs --target linux-x64 --no-runtime
docker build -f installer/docker/Dockerfile -t vayrone/postmaster:0.3.0 .
DB_ROOT_PASSWORD=… DB_PASSWORD=… VPM_HOSTNAME=mail.example.local docker compose -f installer/docker/docker-compose.yml up -d
docker compose -f installer/docker/docker-compose.yml exec postmaster node /opt/vayrone-postmaster/app/vpm.mjs setup-token
```

- **Image contents:** only the built release (`.dockerignore`), running as an unprivileged user.
- **Database:** MariaDB is the official image, running as a separate container.
- **Licensing:** the licence fingerprint uses the host's `/etc/machine-id` (mounted read-only).

---

## Technician checklist

See [docs/technician-checklist.md](../docs/technician-checklist.md).
