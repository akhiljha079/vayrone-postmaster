# Vayrone PostMaster

**Vayrone PostMaster by Vayrone Infratech** — a LAN mail server suite for offices whose mailboxes live at an external provider. It fetches each employee's external mail into a local mailbox, serves it to Outlook, Thunderbird and webmail with a LAN-only password, and relays outgoing mail through one provider account.

> Proprietary software © Vayrone Infratech, Agra, India. Not for redistribution in source form.

## Status

| Phase | Scope | State |
|-------|-------|-------|
| 1 | Architecture, licence audit, folder structure, DB schema | Approved |
| 2 | SMTP, store, IMAP/POP3 with stable UIDs | Delivered |
| 3 | Auth, roles, domains/users, relay queue | Delivered |
| 4 | External fetcher, encrypted credentials, dedup | Delivered |
| 5 | Rules, forwarding, journaling, loop prevention | Delivered |
| 6 | Webmail + realtime | Delivered |
| 7 | Archive, search, backup/restore | Delivered |
| 8 | Licensing + Vayrone License Server | Delivered |
| 9 | Setup wizard, installers, services, branding | Delivered |
| 10 | Compilation, signed updater, monitoring, hardening, docs | **Delivered — awaiting review** |

## Documentation

| For | Document |
|-----|----------|
| Installing | [docs/install-windows.md](docs/install-windows.md), [docs/install-linux.md](docs/install-linux.md) |
| Client administrators | [docs/admin-manual.md](docs/admin-manual.md), [docs/upgrade-guide.md](docs/upgrade-guide.md), [docs/security.md](docs/security.md) |
| Setting up PCs and phones | [docs/mail-clients.md](docs/mail-clients.md) (Outlook, Thunderbird, phones, webmail) |
| Vayrone technicians | [docs/technician-checklist.md](docs/technician-checklist.md), [installer/README.md](installer/README.md) |
| Vayrone engineering | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/release-process.md](docs/release-process.md), [license-server/README.md](license-server/README.md) |

## Read first

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design, and the decisions awaiting approval (§0)
- [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) — dependency licence audit and flagged items
- [db/migrations/001_initial_schema.sql](db/migrations/001_initial_schema.sql) — initial schema

## Repository layout

| Path | Contents |
|------|----------|
| `core/` | Mail engine |
| `server/` | Fastify API, auth, Socket.IO |
| `worker/` | Fetcher, outbound queue, jobs |
| `web/` | React SPA (webmail, admin, wizard) |
| `app/` | The single `vpm` executable (roles core / worker / all / cli) |
| `license-client/` | In-product licensing |
| `license-server/` | Vayrone License Server (separate app) |
| `installer/` | Windows + Linux packaging |
| `db/` | Migrations and generated `schema.sql` |
| `scripts/` | Build, schema and licence-audit tooling |
| `docs/` | Documentation |

## Developer commands

```sh
nvm use                     # Node 24 LTS
npm run db:schema           # regenerate db/schema.sql from migrations
npm run license-audit       # fail on non-allowlisted dependency licences
npm run build:release       # release/<platform>/ (see installer/README.md)
sh scripts/package-linux.sh # .deb + .rpm (needs nfpm)
node scripts/package-windows.mjs  # Windows installer inputs; compiles with Inno Setup on Windows
```
