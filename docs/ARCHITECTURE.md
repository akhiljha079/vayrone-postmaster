# Vayrone PostMaster — Architecture (Phase 1)

*Vayrone PostMaster by Vayrone Infratech.* Status: **draft for approval**. Section 0 lists the decisions I need from you before Phase 2.

---

## 0. Decisions needing approval

| # | Topic | Spec says | Proposal | Why |
|---|-------|-----------|----------|-----|
| D1 | Node.js version | Node 20 LTS | **Node 24 LTS** | Node 20 reached end-of-life on 2026-04-30, so it gets no security patches. Node 24 is supported until April 2028 and has mature SEA support and built-in zstd. |
| D2 | MySQL version | MySQL 8 | **MariaDB 10.11/11.4 LTS or MySQL 8.4 LTS** | MySQL 8.0 reached end-of-life in April 2026. The schema avoids engine-specific syntax. |
| D3 | Search engine | SQLite FTS5 or MySQL FULLTEXT | **MySQL/MariaDB InnoDB FULLTEXT** | It needs no native addon (better-sqlite3 complicates the SEA build) and keeps one datastore to back up. If Hindi/Indic search becomes important we can move to an ngram parser or a sidecar FTS5. |
| D4 | Binary packaging | Node SEA or `pkg` | **Node SEA** | `pkg` is archived. |
| D5 | Process model | "services" | **2 services + DB** (see §2) | Fetcher or backup load can never stall IMAP/SMTP for the office. |
| D6 | LAN password hashing | — | **scrypt (Node built-in)** | No native argon2 addon to ship inside the SEA. |
| D7 | Bundled MariaDB on Windows | bundle | Bundle with GPL compliance, or download the official MSI at install | See THIRD_PARTY_LICENSES.md **F1** |
| D8 | Relay From-address policy | From = employee | Supported, with a **per-user "send via own provider account" fallback** | Several providers (Zoho, Outlook.com and often Hostinger/GoDaddy) reject or rewrite mail whose `From:` differs from the authenticated user. See §5.3. |

---

## 1. System context

```
          Internet / providers (cPanel, Hostinger, Zoho, GoDaddy…)
              ▲  POP3/IMAP fetch          ▲ SMTP submission (one relay account,
              │  (per-employee creds)     │  or per-user override)
┌─────────────┴───────────────────────────┴──────────────────────────────┐
│                  Vayrone PostMaster server (client LAN)                │
│                                                                        │
│  ┌──────────────── vpm-core (service #1) ────────────────┐             │
│  │ SMTP 587/465 ─┐                                        │             │
│  │ IMAP 143/993 ─┼─► Delivery pipeline ─► Message store ◄─┼─ Webmail/API│
│  │ POP3 110/995 ─┘   (rules, dedup,       (EML on disk +  │  HTTPS 443  │
│  │                    journal, archive)    DB metadata)    │  Socket.IO  │
│  └─────────────▲──────────────────────────────────────────┘             │
│      loopback  │ internal API (deliver, notify)                         │
│  ┌─────────────┴──── vpm-worker (service #2) ────────────┐             │
│  │ Fetcher (imapflow / POP3 client)  Outbound relay queue │             │
│  │ Job runner: index, archive, retention, backup, licence │             │
│  └────────────────────────────────────────────────────────┘             │
│  ┌──────── MariaDB (service #3 on Windows / system pkg) ──┐             │
│  └────────────────────────────────────────────────────────┘             │
└────────────────────────────────────────────────────────────────────────┘
        ▲ Outlook / Thunderbird / browser (LAN-only password)
```

## 2. Processes and services

There is **one executable, `vpm` (`vpm.exe`)**, started in different roles:

| Role | Windows service | systemd unit | Contents |
|------|-----------------|--------------|----------|
| `vpm core` | `VayronePostMaster` | `vayrone-postmaster.service` | SMTP, IMAP, POP3, HTTPS API + SPA + Socket.IO, setup wizard. **The only writer of mailbox state** (UIDs, flags, folders). |
| `vpm worker` | `VayronePostMasterWorker` | `vayrone-postmaster-worker.service` | External fetcher, outbound queue sender, job runner, scheduler. |
| `vpm all` | — | — | Both roles in one process, for small sites and development. |
| MariaDB | `VayronePostMasterDB` (bundled) | distro `mariadb.service` | |
| `vpm cli …` | — | — | Admin tools: `migrate`, `backup`, `restore`, `reset-admin`, `license request|import`, `diag`. |

**Inter-process communication.** (Revised in Phase 4.)
- All three processes use the same core library for mailbox writes. Every write is a DB transaction that locks the affected folder rows (UID and MODSEQ allocation, dedup ledger), so writes from different processes are safe. The worker therefore delivers fetched mail and bounces directly. There is no extra hop through core.
- After a write, the process that made it calls `events.folderChanged()`. In the worker and web processes this is forwarded to core over **loopback IPC**:
  - an HTTP `POST /v1/events` on `127.0.0.1:<ipc.port>`;
  - authenticated with a shared token in `<data>/ipc.token`;
  - batched for 50 ms.
- Core then wakes the IMAP IDLE sessions. Measured end to end across processes (provider → worker IDLE watcher → fetch → IPC → Outlook IDLE): **about 0.4 s**.
- The DB is always the source of truth. A lost notification only delays an update until the client's next command.
- The worker discovers work by polling the DB:
  - the outbound queue every 2 s;
  - due external accounts every 1 s;
  - IDLE watcher changes every 5 s.
  - Admin actions such as "Fetch now" just update the account row.

The optional Redis/Valkey adapter replaces the nudges and the job-queue polling for very large sites. It is never required.

Windows services use **WinSW** with automatic restart and depend on the DB service. Linux units use `Restart=always`, `User=vpm`, `ProtectSystem=strict`, `ReadWritePaths=<data path>`, and `AmbientCapabilities=CAP_NET_BIND_SERVICE` for ports below 1024.

### 2.1 Packaging, first start and the setup wizard (Phase 9)

- **Entry point:** `app/src/bin.ts` is bundled by esbuild into one file, `app/vpm.mjs` (`scripts/build-release.mjs`).
  - Roles: `core`, `worker`, `all`.
  - `core` runs the mail listeners and the web role in one process. The web role's events reach IMAP IDLE in-process; only the worker uses loopback IPC.
  - Development keeps separate `npm run dev` entry points per role.
- **Config files:**
  - `vpm.config.json` is owned by root/Administrators and read-only for the service account. It holds DB credentials, paths and key locations.
  - Settings the wizard or admin panel may change (hostname, listen address, ports, TLS files) live in `<data>/runtime.json` and override the config at start (`applyRuntimeOverrides`).
- **`vpm init` (installers):**
  1. creates the database and a dedicated DB user with a random password (through MariaDB root: unix socket on Linux, the bundled instance on Windows);
  2. writes the config;
  3. creates the master key (DPAPI on Windows, a root:vpm 0440 file on Linux);
  4. loads `schema.sql`;
  5. writes `<data>/setup.token`.
  - Re-running it on an existing install only migrates.
- **Setup wizard** (`/setup`, API `/api/setup`):
  - Open until `setup_state.completed_at` is set.
  - Every call needs the setup token (header `x-vpm-setup`), except from the server itself.
  - Steps: licence → company (+ logo) → domains → super admin → relay (+ test send) → network/TLS → storage/backup/retention → summary.
  - Finishing removes the token, writes `setup.complete` to the audit log, and (if ports/TLS changed) requests a restart.
  - Afterwards the API answers 410.
- **Restart:**
  - `requestRestart()` stores a timestamp in `settings(system, restart)`.
  - Every process polls it every 5 s and exits with code **75** after a graceful stop.
  - systemd (`Restart=always`) and WinSW (`onfailure restart`) start the process again with the new settings.
- **Services:**

  | Platform | Database | Core | Worker |
  |----------|----------|------|--------|
  | Windows (WinSW) | `VayronePostMasterDB` (bundled MariaDB 11.4, 127.0.0.1:3307) | `VayronePostMaster` | `VayronePostMasterWorker` |
  | Linux (systemd) | distro MariaDB | `vayrone-postmaster.service` (`CAP_NET_BIND_SERVICE`) | `vayrone-postmaster-worker.service` |

  - Linux units run as user `vpm`, sandboxed.
  - Details: [installer/README.md](../installer/README.md).

## 3. Repository layout

```
/core            mail engine (SMTP, IMAP, POP3, store, delivery pipeline, rules)
/server          Fastify API, auth, RBAC, Socket.IO, wizard backend
/worker          fetcher, outbound queue, jobs, backups
/web             React + Vite + Tailwind SPA
/license-client  licence verification, fingerprint, activation, enforcement
/license-server  separate Vayrone-hosted app (own DB)
/installer       windows/ (Inno Setup, WinSW, MariaDB), linux/ (deb, rpm, systemd, install.sh), docker/
/db              migrations/NNN_*.sql, generated schema.sql
/scripts         build-schema, license-audit, build/sign tooling
/docs            architecture, install, admin, client setup, upgrade, technician checklist
```

Language: **TypeScript (strict)** compiled by esbuild into one bundle per role, then embedded into the SEA executable (§10).

## 4. Storage

### 4.1 Database
MariaDB/MySQL over `mysql2` with `kysely` as the query builder. The connection pool uses `time_zone='+00:00'` and `sql_mode` including `STRICT_ALL_TABLES`. Schema: `db/migrations/001_initial_schema.sql` (about 48 tables, grouped into 13 sections).

### 4.2 Message bodies: single-instance, content-addressed
- When a raw message arrives, core normalises line endings to CRLF, so the stored size equals the octets served over IMAP and POP3. It computes the SHA-256 and compresses the message. The codec is recorded per row: zstd where the runtime has it (always on Node 24), gzip otherwise. Core then writes to `tmp/`, fsyncs, and atomically renames to `store/ab/cd/<sha256>.eml.zst`.
- `messages.refcount` counts the mailbox items, archive items and outbound queue rows that reference the file. Fan-out to 50 recipients, journaling and archiving therefore store the bytes once.
- Per-recipient data (target user, origin, external account) lives only in `mail_items`. Nothing per-recipient is written into the shared file, so its bytes, hash and `RFC822.SIZE` are identical for every copy.
- The root header block is also cached in `messages.header_raw` (migration 002). Header-only FETCHes (Outlook/Thunderbird initial sync) and header SEARCH never decompress the file.
- GC deletes a file only when `refcount = 0` **and** the row is older than 24 h. That 24 h grace window protects in-flight deliveries and restores.
- ENVELOPE and BODYSTRUCTURE are parsed once and cached as JSON, so IMAP FETCH of headers or structure never touches the disk file.
- Backups re-hash every file (see §7); the nightly job re-verifies the newest backup on each target.

### 4.3 Data path layout (configurable)
```
<data>/store/        message files
<data>/tmp/          in-flight writes (same volume, for atomic rename)
<data>/exports/      archive exports
<data>/logo/         client logo
<data>/certs/        nothing secret; private keys live encrypted in the DB
<backup>/            default local backup target
```

## 5. Mail flows

### 5.1 Inbound from providers (fetch)
1. The worker schedules each `external_account`:
   - IMAP with IDLE: keeps one IDLE connection per remote folder and reconnects with backoff.
   - Otherwise: polls every `interval_sec` (10–30 s, with ±10 % jitter).
2. For each new remote message, look up `external_seen` by `(account, remote_key)`. If it's already there, skip it without downloading.
3. Download, then run the delivery pipeline (§5.4) in the worker with `origin:'fetch'`. A quota check comes first: if the mailbox is full, the run stops with status `quota_full` and the mail stays on the provider.
4. Once the local commit is done, insert the `external_seen` row and notify core over IPC.
5. Leave-on-server policy: `delete` deletes right after commit; `keep_days` deletes when `first_seen_at` plus N days has passed; `keep` never deletes.

Notes on step 2:
- Remote keys are `pop3:<UIDL>`, `pop3h:<sha256 of TOP n 0>` (for servers without UIDL), or `imap:<folder>:<uidvalidity>:<uid>`.
- If an IMAP UIDVALIDITY changes (the provider rebuilt the mailbox), messages whose Message-ID is already in the mailbox are skipped without downloading.
- Each run downloads at most 200 messages (`worker.fetchMaxPerRun`), so a large first sync does not starve other accounts. The run is rescheduled immediately.

Ordering guarantees we **never lose mail**: the remote copy is deleted only after the local commit. A crash between steps 3 and 4 causes a re-download, which content dedup then suppresses.

### 5.2 LAN submission (Outlook / Thunderbird / webmail)
1. The client connects to 587 (STARTTLS) or 465 (TLS) and AUTH PLAIN/LOGIN with the LAN password. Allowed only if `allow_smtp` is set and the IP is allowlisted.
2. Sender check: the envelope and `From:` must be one of the user's own addresses, or an alias/list they may send as.
3. Recipients are split:
   - Local mailbox, alias or list → internal delivery (§5.4), never touching the internet.
   - External address, or an unknown address in a local domain with `unknown_recipient_action=relay` → `outbound_queue`.
4. A copy goes to the user's Sent folder only when the submission came from webmail. Outlook saves its own copy.
5. Journal and archive hooks run for outbound mail.

### 5.3 Outbound relay
- Route resolution: user `relay_routes` → domain `relay_routes` → domain smart host → default `relay_accounts`.
- Sent with nodemailer from the worker:
  - pooled connections per relay with a per-relay rate limit;
  - per-recipient status;
  - retry schedule of 1, 5, 15, 30 and 60 min, then hourly until `expires_at` (default 3 days).
  - Retries stop on a permanent 5xx.
- `From:` stays the employee's address. Envelope `MAIL FROM` is the relay account by default, which aligns with the provider's SPF/DKIM. Optionally `Sender: mailserver@…` is added.
- **Provider caveat (D8):** some providers refuse a `From:` that differs from the authenticated login. Mitigation: the admin can set a per-user route `via_external_account_id`, which sends with that employee's own provider credentials. We already store those (encrypted) for fetching. The setup wizard's test send detects the rejection and suggests this.
- A permanent failure, or expiry, generates a DSN (RFC 3464) that is delivered locally to the sender.

### 5.4 Delivery pipeline (`core/src/mailflow.ts`, revised in Phase 5)
```
raw → store file once (by sha256) → parse/cache envelope + structure
  per recipient mailbox:
    1. plan   = company rules (in order) → user rules (in order) → forwarding settings
                pure evaluation, no side effects; stop/reject/discard end evaluation
    2. reject/discard/redirect-only → record in the dedup ledger only (atomic)
       otherwise → ONE transaction: dedup check + UID allocation + insert
    3. only if step 2 was a NEW message (not a duplicate):
         copies to other folders, forwards, redirects, auto-replies, out-of-office
    4. COMMIT → notify (in-process events / IPC to core) → IMAP IDLE, web
  once per message: journal rules → BCC copies (X-VPM-Journal-* headers)
LAN submission: outbound company rules first (reject → SMTP 550 to Outlook,
  add header, BCC copy) → local recipients as above → relay queue → journal once
```
- **Origins and directions:** `in` is fetched provider mail; `internal` is LAN to LAN; `out` is LAN to the internet. Rules can test the direction.
- **Rule caching:** global rules are cached for 10 s per process, so changes take effect within 10 s everywhere. Settings, including the forwarding policy, are cached for 30 s.
- **Side effects are at-most-once.** They run after the commit. A crash between the commit and the side effect can lose one forward or auto-reply, but never the mail itself and never a duplicate.
- **Forwarding policy** (`settings mail.policy`):
  - Employees may only forward or redirect to company domains unless the Super Admin allows outside addresses. Admin-configured forwarding is always allowed.
  - When an outside sender's mail is forwarded to an outside address, `From:` is rewritten to "Name via Employee <employee@company>". `Reply-To:` keeps the original sender and `DKIM-Signature` is removed. Otherwise relay providers and DMARC checks reject or spam-folder the forward.
- **Auto-replies** follow RFC 3834:
  - never to lists, bulk or auto-submitted mail, null or no-reply senders, or the user themself;
  - never when the user was not in To/Cc (Bcc and list copies);
  - at most once per sender every N days.
- **Rule safety:** regexes are capped at 200 characters and patterns with nested quantifiers are refused. A rule that throws while being evaluated is skipped, never blocking delivery.

### 5.5 Duplicate and loop prevention
- **Message-ID key:** SHA-256 of the normalised `Message-ID` header.
- **Content key:** SHA-256 of a canonical form: drop trace headers (`Received`, `Return-Path`, `Delivered-To`, `X-*`, `DKIM-Signature`, `ARC-*`), unfold, lower-case header names, normalise line endings and trailing whitespace, then append the body.
- **Decision rule:** the content key decides. The canonical form keeps the `Message-ID` header, so a content hit implies the same Message-ID. The Message-ID key is recorded for diagnostics only, so a broken sender that reuses Message-IDs for different mail is never suppressed.
- The `dedup_ledger` is per user. A hit within the window (default 72 h) means skip, and log `duplicate`. Ledger rows are written with `INSERT IGNORE` in the same transaction as the append, so two concurrent deliveries can't both pass. This covers:
  - fetch re-downloads;
  - the same mail arriving via two external accounts;
  - a BCC copy plus a direct copy;
  - forward echoes.
- Messages without a Message-ID use only the content key.
- **Loops:** each forward, redirect, journal copy or auto-reply adds `X-VPM-Loop: <install-id>`. A message that comes in with our ID already present is delivered normally, but never forwarded, redirected or answered again. The `loop_blocked` event is written to the mail log. Messages with more than 30 `Received:` headers are treated the same way, which catches loops through other systems.
- **Forwards to colleagues** go through the same per-mailbox dedup. The loop header is an `X-` header and is ignored by the content key, so a colleague who already got the message (e.g. on Cc) does not get a second copy. Auto-replies also follow RFC 3834:
  - skip senders with `Auto-Submitted`, `Precedence: bulk/list`, or `List-*` headers;
  - skip null senders;
  - reply to the same sender at most once per N days (`autoreply_log`).

## 5.6 Webmail and realtime push (Phase 6)
- **API:** `/api/mail/*`: folders, message list (newest first, preview line stored at ingest, migration 005), read, flags/move/delete, attachments, raw `.eml`, compose, reply, forward, drafts, uploads, contacts.
  - Sending from webmail goes through `mailflow.submission`, the same path as Outlook's SMTP, so company rules, outbound rejects, journaling and the relay all apply.
  - The Sent copy keeps Bcc, like Outlook does; the delivered copy never contains it.
- **Displaying untrusted HTML**, in three layers:
  1. `sanitize-html` on the server removes scripts, event handlers, forms, frames and `javascript:` URLs.
  2. The browser renders the result in an `<iframe sandbox>` **without `allow-scripts`**, with its own CSP (`default-src 'none'`).
  3. Remote images are disabled until the user clicks "Show images" (this stops tracking pixels). Inline `cid:` images are embedded as data URIs.
  - Attachments are always downloaded with `Content-Disposition: attachment`, `nosniff` and a sandbox CSP.
- **Realtime:** Socket.IO runs in the web process.
  - **Authentication:** the session cookie authenticates the socket, the origin must match, and sessions are re-validated every 60 s so revoked sessions are disconnected.
  - **Event path:** every folder change in any process reaches the web process. Core's IPC server re-broadcasts changes on `GET /v1/stream` (server-sent events, token-protected), including those the worker publishes, and the web process subscribes.
  - **Delivery:** changes are batched per user (250 ms) and emitted as `mail {folders}`.
  - Measured live: SMTP delivery in core → browser in about 0.6 s.

## 5.7 Archive, search and maintenance (Phase 7)
- **Compliance archive:**
  - **What is archived:** every message that is delivered or sent gets one `archive_items` row, holding a reference on the stored message. The row records direction, envelope sender and recipients, and the local mailboxes involved. A re-downloaded duplicate is never archived again.
  - **Retention:** the longest matching retention policy wins (all/domain/group/user); the default is 7 years. Legal hold blocks deletion.
  - **Access:** nobody can edit or delete archive items. Admins and auditors search, view and export; admins can copy a message back into a mailbox. Every search, view, download and export is audit-logged.
  - **License:** the archive needs the license feature `archive`.
- **Full-text search:** the worker indexes new messages into `message_search` (InnoDB FULLTEXT) in the background. It covers:
  - decoded body text, up to 1 MiB per message;
  - attachment names;
  - names and addresses.
  - Queries are built safely in BOOLEAN MODE: every word is required, prefix-matched, and quoted phrases are supported. Hindi/Devanagari is supported (verified on MySQL 8).
  - Webmail and archive search combine the index (bodies) with substring matching on headers.
- **Nightly jobs** (worker scheduler, DB-backed queue, one run per time slot even with several workers):
  - archive retention and mailbox folder retention (e.g. Trash after 30 days);
  - garbage collection of message files whose reference count is 0 for more than 24 h, re-checked against real references, so wrong counters are repaired, never trusted;
  - housekeeping of old queue, ledger and log rows;
  - verification of the newest backup on every target;
  - an hourly backup-freshness alert.

## 5.8 Filtering and quarantine (Phase 11)

Code: `core/src/filter/` (migration 009).

- **One check per message, before any recipient gets it.** `MailFilter.check()` runs in `mailflow` for inbound (fetched), internal and outbound (submission) mail. Local delivery of already-checked mail uses `skipFilter`.
- **Order:**
  1. **Blocked attachments:** extension list, including RFC 2231 / encoded-word file names and names inside ZIP files.
  2. **Virus scan:** ClamAV `INSTREAM` over TCP or a Unix socket.
     - Fails open by default (deliver and raise an alert), or holds the message (`onError: quarantine`).
     - Needs the `antivirus` licence feature.
  3. **Spam score:**
     - built-in rules: provider spam flags, SPF/DMARC failures, display-name spoofing, link-text mismatch, phrases, …;
     - or Rspamd `/checkv2`.
  4. **Sender allow/block lists:** global, then per user.
- **Verdicts:**
  - `deliver`;
  - `junk`: the Junk folder plus `X-VPM-Spam*` headers (on Junk copies only);
  - `quarantine`;
  - `reject`: outbound only, returned to the sender as an SMTP 550 with the reason.
- **Quarantine never loses mail.**
  - The message blob is ref-counted like any mailbox copy.
  - Delivery rows are recorded as `quarantined`, so fetch dedup does not fetch the message again.
  - Recipients get a notice.
  - Release re-runs normal delivery. A **virus** release is super-admin only.
  - The nightly retention task purges rows after `quarantineDays`.
- **Learning:** webmail *Junk* / *Not junk* adds the sender to that user's list (`source = webmail`).

## 5.9 Optional Redis / Valkey bus (Phase 11)

- **Default:** core and worker exchange folder-change events and job nudges over loopback IPC.
- **With `redis.url` in the config:** they use pub/sub instead (`core/src/redisbus.ts`):
  - **`vpm:events`:** folder changes are batched every 50 ms; a node ignores messages it published itself;
  - **`vpm:jobs`:** `enqueueJob` notifies the worker, which wakes immediately instead of waiting for its poll.
- **Purpose:** this lets several core nodes share one worker.
- **Not required for correctness:** jobs still live in MySQL.
- **Recommended server:** Valkey (BSD-3). See THIRD_PARTY_LICENSES F6.

## 6. IMAP / POP3 servers (in-house)

**IMAP:**
- Standards (shipped in Phase 2): IMAP4rev1 (RFC 3501) plus IDLE (2177), UIDPLUS (4315), MOVE (6851), SPECIAL-USE (6154), CHILDREN, NAMESPACE, ID, ENABLE, UNSELECT, LITERAL+ (7888), SASL-IR, and STARTTLS/993.
- CONDSTORE (7162) is also shipped: HIGHESTMODSEQ, FETCH MODSEQ/CHANGEDSINCE, STORE UNCHANGEDSINCE, SEARCH MODSEQ.
- QRESYNC is schema-ready (`folder_expunges`) and planned with webmail (Phase 6).
- `\Recent` is not tracked and always reports 0, which matches RFC 9051 (it dropped the flag).
- The command tokenizer, FETCH, SEARCH and the session state machine are all written in-house. No third-party IMAP code is used.
- Outlook-specific items:
  - correct `\Sent`/`\Trash` special-use flags;
  - tolerate the `"` + `/` hierarchy quirks;
  - fast `UID FETCH 1:* (FLAGS)` on large folders (one indexed query);
  - send IDLE keep-alives every 25 minutes or less.

**POP3:**
- Standards: RFC 1939 plus UIDL, TOP, CAPA, STLS, and AUTH PLAIN/USER.
- Serves INBOX only.
- `DELE` + `QUIT` performs an expunge, which also updates `folder_expunges` so IMAP clients stay consistent.

## 7. UID stability: no re-download when switching clients

These rules are enforced in code and verified by Phase 2 tests:

1. `folders.uidvalidity` comes from `users.next_uidvalidity`. That counter is seeded with the Unix time when the user is created, and is incremented each time a folder is created. It is never recomputed.
   - Deleting and recreating a folder gives it a *new* UIDVALIDITY, which is the correct IMAP behaviour.
   - Renaming a folder keeps its UIDVALIDITY.
2. UIDs are allocated with `UPDATE folders SET uidnext = LAST_INSERT_ID(uidnext + n)` inside the delivery transaction. UIDs are strictly increasing and never reused, and `uidnext` never decreases (not even after expunge).
3. `mail_items.pop3_uidl` is assigned once at insert as `"<uidvalidity>.<uid>"` and stored. It is never derived again at read time.
4. Backup stores `folders` (uidvalidity, uidnext, highest_modseq), `mail_items` (uid, modseq, pop3_uidl, flags) and `users.next_uidvalidity` **verbatim**.
   - Restore writes those values back as they are.
   - A single-user or single-folder restore into an existing mailbox goes into a new "Restored <date>" folder. That way existing UIDs are never renumbered.
5. Reindexing, search rebuilds, upgrades and migrations never touch these columns. A CI test diffs UID/UIDL snapshots before and after `migrate`, `backup → wipe → restore`, and `reindex`.
6. Result: if Outlook switches to another provider and back, it sees the same UIDVALIDITY and UIDs (IMAP) or the same UIDLs (POP3), so it downloads nothing again.

### 7.1 Backup format and restore (Phase 7)
```
<target>/vpm-<kind>-<timestamp>-r<run>/
  manifest.json          format, versions, base run, SHA-256 of every file
  db/<table>.jsonl.gz    every table, typed JSON lines, from ONE consistent snapshot
  store-index.jsonl.gz   message files in this run (path, size, SHA-256)
  store/…                message files (full: all; incremental: new since the base)
```
- **Writing:** a run is written as `<dir>.partial` and renamed when complete. It is verified (every hash) right after writing.
- **Rotation:** keeps the newest N full chains per schedule.
- **Format:** our own dump format, with no `mysqldump` dependency, so it is identical on Windows and Linux and between MySQL and MariaDB. Sessions, locks and jobs are not backed up.
- **Targets:** any folder (local disk, a mounted NAS share, a Windows UNC path, a USB drive). S3 and FTP targets are not implemented yet.
- **Full restore** (`vpm cli restore-full`, services stopped):
  1. verifies the chain;
  2. refuses backups made by newer software;
  3. runs migrations;
  4. reloads every table verbatim and copies message files with hash checks.
  - The result is that UIDVALIDITY, UIDs, MODSEQs and POP3 UIDLs are identical. This is verified by an end-to-end test against a freshly created database.
- **Partial restore** (admin panel, live; user, folder and/or date range):
  - a folder that no longer exists is recreated with its original identity;
  - a folder that exists only receives missing messages, appended with new UIDs;
  - a deleted user can be recreated with the original id, login and folders.
  - Existing UIDs are never renumbered.

## 8. Realtime and performance

- **External → LAN latency:** IMAP IDLE gives ~1–3 s. Polling adds at most the interval. After commit, core pushes to IMAP IDLE sessions and Socket.IO immediately.
- **Fetcher:**
  - global concurrency cap (default 50 connections);
  - per-provider-host cap (default 8), so Hostinger does not rate-limit us;
  - per-account isolation, so one account's failure never blocks another;
  - exponential backoff with jitter: 30 s, then 1, 2, 4, 8 and 15 min;
  - `auth_failed` accounts pause until edited and raise an admin alert.
- **Sizing target:** 500 users, 1000 external accounts, on 8 vCPU, 16 GB RAM and SSD.
  - At most 1000 IDLE sockets is trivial for Node.
  - DB pool: 20 (core) + 20 (worker).
  - Hot paths are a single indexed query each.
- **IDLE fan-out:**
  - The fetcher starts IDLE watchers in batches (25 every 100 ms).
  - It skips the reconnect catch-up for accounts fetched in the last 60 s.
  - Accounts whose watcher reports new mail (`EXISTS`) jump an **urgent queue** ahead of routine polls. Without this, 1000 reconnect catch-ups delayed real pushes by more than 30 s.
- **Load test:** `scripts/loadtest.sh` (`worker/test/load.test.ts`). Results are in [performance.md](performance.md).

## 9. Security

- **Secrets:**
  - AES-256-GCM envelopes: `[key_version][iv 12][tag 16][ciphertext]`. Key rotation re-encrypts lazily.
  - The master key (32 random bytes) is created by the installer:
    - **Windows:** encrypted with DPAPI (LocalMachine scope) through a PowerShell `ProtectedData` call at service start. Only the encrypted blob is on disk.
    - **Linux:** `/etc/vayrone-postmaster/master.key`, mode `0440`, owner `root:vpm`.
  - Passwords are **write-only** in every API (responses show `"secret_set": true`).
- **LAN passwords:** scrypt (N=2^15, r=8, p=1) with a per-user salt, compared in constant time.
- **Web:**
  - opaque session cookie (`HttpOnly`, `Secure`, `SameSite=Strict`), with only its SHA-256 stored;
  - CSRF double-submit;
  - Helmet CSP;
  - TOTP 2FA with recovery codes;
  - lockout: 5 failures → 15 min, scaled per IP and per account;
  - IP allowlist per protocol.
- **Roles:** RBAC is checked in the API layer and never trusted from the UI.
  - `auditor` is read-only.
  - `vayrone_support` exists only if the licence has `support_access`. A site admin can toggle it, and all of its actions are flagged `is_support` in the hash-chained audit log.
- **TLS:** self-signed (generated in the wizard) or uploaded. One active certificate, shared by HTTPS, IMAPS, POP3S, SMTPS and STARTTLS.

## 10. Licensing, IP protection, updates and operations (Phases 8 and 10)

### 10.1 Licence file (`license-client/src/format.ts`)

- **Envelope:** `{ format, kid, payload, sig }`.
  - `payload` is the base64url of the JSON bytes exactly as issued, so no canonicalisation is needed.
  - `sig` = Ed25519 over `"<format>\n<payload>"`. The document type is part of the signed message, so a revocation can never be replayed as a licence.
- **Armour:** files are ASCII-armoured (`-----BEGIN VAYRONE POSTMASTER LICENSE-----`) so they survive email and copy/paste.
- **Document types:**
  - `vpm-license/1`: the licence;
  - `vpm-revocation/1`: a transfer/suspension notice;
  - `vpm-integrity/1`: the program-file manifest;
  - `vpm-request/1`: the offline request (unsigned).
- **Licence fields:**
  - licence id and key hint;
  - client (name, contact, GSTIN, city);
  - partner;
  - plan;
  - `maxUsers`, `maxExternalAccounts`;
  - feature flags (`archive`, `backup_cloud`, `antivirus`, `support_access`, `journaling`, `external_fetch`);
  - `issuedAt` (License Server clock), `expiresAt` (null = perpetual), `amcExpiresAt`;
  - `checkBy`: re-validate before this date (online 30 days, refreshed daily; offline 90 days);
  - `heartbeatHours`;
  - the activation (id, mode, machine id, hashed components).
- **Keys:**
  - Public keys are listed by key id in `license-client/src/keys.ts` and written by `scripts/license-keygen.mjs`. That script writes the private key **outside** the repository (mode 600).
  - Several kids can coexist, for key rotation.
  - Development builds also trust `<dataPath>/dev-license-keys/<kid>.pem`. Release builds compile with `__VPM_RELEASE__ = true`, which removes that path; nothing at runtime can switch it back on.
- **Licence keys:** `VPM-XXXXX-XXXXX-XXXXX-XXXXX-C`. They use Crockford base32 with a check character, so typing mistakes are caught locally; O/0 and I/L/1 are accepted interchangeably.

### 10.2 Machine fingerprint (`fingerprint.ts`)

- **Components:** five, each hashed separately (salted SHA-256, truncated to 128 bits):

  | Component | Source |
  |-----------|--------|
  | `os` | `/etc/machine-id` / `MachineGuid` |
  | `board` | baseboard serial, else BIOS/system serial |
  | `uuid` | SMBIOS system UUID |
  | `disk` | serial of the disk holding the data directory |
  | `cpu` | model, family/stepping, core count |

- **OEM placeholders** ("To be filled by O.E.M.", all-zero UUIDs, …) count as missing.
- **Matching rule:** the licence holds while **at most one** licensed component changed and **at least three** still match (fewer if the machine exposed fewer at activation).
- **Machine ID:** the display id (`7F3KQ-2M9XA-…`) changes with any component, so it is shown for support only and never used for matching.
- **Collection:**
  - Linux: sysfs/procfs plus `/dev/disk/by-id`. DMI serials are root-only, so the systemd unit (Phase 9) runs `vpm cli hwid --write /run/vayrone-postmaster/hwid` as root before start.
  - Windows: one PowerShell CIM query, run as LocalSystem.
- **On the License Server:** a heartbeat that still matches updates the stored components, so gradual hardware upgrades are followed. A heartbeat from different hardware is logged as `clone_suspected`.

### 10.3 States and enforcement (`evaluate.ts`, a pure function)

| State | When | Mode |
|-------|------|------|
| `unlicensed` | no licence; 30-day evaluation from the first migration, max 5 users | `unlicensed`, then `readonly` after 30 days |
| `active` | valid, `now ≤ min(expiresAt, checkBy)` | `active` (warning banner 30 days before expiry / 7 days before `checkBy`) |
| `grace` | expired, validation overdue, or revoked/transferred | `grace` for 15 days |
| `expired` | grace over | `readonly` |
| `fingerprint_mismatch` | 2+ parts changed | `grace` for 15 days from first detection (sealed), then `readonly` |
| `tampered` | signature invalid, clock set back > 2 h below the high-water mark, program files modified | `readonly` until fixed (automatic recovery) |

- **`readonly`:**
  - admin API writes return `LICENSE_READONLY`, except the licence page;
  - non-admin web logins are blocked;
  - **IMAP/POP3/SMTP, fetching, relaying, archiving and backups keep running in every state.**
  - Seat and feature limits stay as licensed.
- **Seats:** user create/enable checks `licensedUserCount` (enabled mailbox users, excluding Vayrone Support). The CLI uses the same gate.

### 10.4 Runtime state (`manager.ts`, migration 007)

- **`license_state` (one row):**
  - the signed licence blob, plus a signed revocation blob;
  - `state_seal`: AES-256-GCM with the master key, holding the install date, the clock high-water mark and the hardware-change date. Editing the DB cannot rewind these.
  - `secret_seal`: the licence key and the online activation token.
  - The other columns are a display cache.
- **Clock-rollback floor:** max(sealed high-water mark, licence `issuedAt`, revocation `issuedAt`).
- **Recovering from a wrong-forward clock:** a signed server time that agrees with the local clock (±10 min) resets the high-water mark. This happens on online activation, on heartbeat, or on importing a fresh offline file.
- **Processes:**
  - Every process (core, web, worker, CLI) evaluates independently every 60 s, so admin-panel actions apply everywhere within a minute.
  - Writes take `SELECT … FOR UPDATE`.
  - The worker sends the heartbeat (daily; hourly retries after a failure).
  - State changes go to `license_events` and raise an admin alert.
- **Integrity:** release folders ship `integrity.vsig` (`scripts/sign-integrity.ts`). It is verified at start and daily; a missing manifest in a release build counts as tampering.

### 10.5 Vayrone License Server (`/license-server`, separate deployment, own DB)

- **Product REST API** (`/api/v1`, rate-limited):

  | Endpoint | Body | Returns |
  |----------|------|---------|
  | `activate` | `{key, machine, product, usage}` | licence + token |
  | `heartbeat` | `{licenseId, activationId, token, machine, product, usage}` | refreshed licence, or a revocation |
  | `deactivate` | — | releases the slot, returns a transfer revocation |
  | `offline` | request file | licence file (public portal) |

  The token is stored as SHA-256 and compared in constant time.
- **Admin UI** (React, `license-server/web`):
  - Roles:
    - owner;
    - Vayrone staff;
    - partner, scoped to its own clients and licences, within licence/user quotas, using plan defaults.
  - Screens:
    - clients;
    - plans with per-user price slabs and quotes (GST 18%);
    - licence keys; activations and machine transfers;
    - renewals and AMC, extending from the current end date;
    - suspend/revoke, with a reason shown to the client;
    - offline request inspect/issue;
    - reports: seats sold vs used, renewals due, AMC due, upgrade candidates, stale installs, possible copies, revenue, partners, versions; CSV export.
- **Reminders:**
  - Daily at 09:30 IST, by email (SMTP) and WhatsApp (Meta Cloud API templates or a generic BSP webhook).
  - Defaults: 30/15/7/3/1/0 days before expiry and 7/14 days after; AMC 30/7/0.
  - Sent once each, with the partner in copy, plus a sales digest.
- **Secrets:**
  - The signing key is a file readable only by the service user; a warning is logged if it is group/world-readable.
  - SMTP/WhatsApp credentials are sealed with a separate AES key and write-only in the API.

### 10.6 Compilation and IP protection (Phase 10, `scripts/build-release.mjs`)

| Step | What it does |
|------|--------------|
| 1. Bundle | esbuild bundles `app/src/bin.ts` (all roles) to one CommonJS file. `__VPM_RELEASE__` and `__VPM_SEA__` are compile-time constants. |
| 2. Obfuscate | The licensing code (`license-client/src`) goes through `javascript-obfuscator` with every string encoded, control flow flattened and a fixed seed (reproducible). |
| 3. Bytecode | The bundle is compiled to **V8 bytecode** by the official Node.js 24 binary of the target platform (`scripts/sea/compile-bytecode.cjs`, bytenode technique: eager compilation, no bytecode flushing). |
| 4. Single executable | The bytecode is embedded as a Node SEA asset and injected into that same Node.js binary with postject. A small loader runs it with a same-length placeholder source. The binary is code-signed (Authenticode on Windows, ad hoc on macOS). |

- **Build checks:**
  - no `.map`, `.ts` or `src/` files in the release;
  - no private key, except smtp-server's public demo key, which is allowlisted;
  - sampled bundle text is absent from the executable (string constants aside);
  - licensing function names and strings are absent after obfuscation.
- **Integrity:** `integrity.vsig` (signed SHA-256 of every file) is verified at start and daily. A modified file puts the licence into `tampered`.
- **Platform:** bytecode is platform-specific, so Linux and Windows builds run on their own platform in CI (`.github/workflows/release.yml`). `--format node` (bundle plus runtime) remains for Docker and cross-builds.
- **Honest note:** bytecode, obfuscation and integrity checks make reverse engineering and patching expensive; they do not make it impossible. The licence signature (server-side private key) is what cannot be forged.

### 10.7 Signed updates (Phase 10)

- **Package format `.vpmupdate`:**
  - layout: `VPMUPDATE/1` header, then a signed manifest (`vpm-update/1`: version, target, packageFormat, releasedAt, minVersion, notes, and each file's path, size, SHA-256 and offset), then the gzip-compressed files;
  - channel index: `latest.vidx` (`vpm-update-index/1`) per channel (stable/beta) and target;
  - built by `scripts/make-update.ts`; verified by `@vpm/license-client/update` (signature, then every file hash, then path safety).
- **Flow:**
  1. **Check:** the worker checks the channel daily; Admin → Updates also has *Check now*.
  2. **Get the package:** download (SHA-256 against the index), or upload an offline file. Either way the package is fully verified and staged in `<data>/updates/download`.
  3. **Request:** *Install* checks the AMC rule (the release date must be on or before the AMC end) and writes `<data>/updates/apply.json`.
  4. **Apply:** the privileged updater (Linux: `vayrone-postmaster-updater.path` → oneshot root service; Windows: `VayronePostMasterUpdater` service polling every 10 s):
     1. re-verifies the package;
     2. checks version, target and `minVersion`;
     3. takes a database-only snapshot (`runBackup({ kind: 'pre_update', dbOnly })`);
     4. stops the services;
     5. swaps files by rename (the old ones go to `<home>/.rollback`; renaming the running `vpm.exe` works on Windows);
     6. starts the services, which migrate the database;
     7. polls `/api/health` until it reports the new version.
- **Rollback:** on failure, files move back; if the schema changed, the snapshot is restored with `restoreFull({ dropExisting: true })` against the old migrations; the services start again. `update_history` keeps the step log.
- **Docker:** `VPM_DOCKER=1` turns the in-app updater off; update by pulling images.

### 10.8 Monitoring and hardening (Phase 10)

- **Health snapshot** (`core/src/monitor.ts`, Admin → System health, `/metrics` with a bearer token): database, disk, store, users, queue, fetch, backups, TLS expiry, licence, alerts, process.
- **Worker checks every 5 minutes**, raising and resolving alerts for: disk low, outgoing queue stuck, external mailboxes failing, certificate expiring.
- **Alert e-mails** go to local mailboxes (always delivered) and external addresses (outbound queue, source `system`), once per alert per day.
- **Nightly checks:** the audit-log hash chain (`audit.tampered`), and backup freshness and integrity (existing).
- **Hardening:**
  - per-address and total connection caps for SMTP/IMAP/POP3 (`core/src/connlimit.ts`, config `limits`);
  - HTTP request timeouts, `no-store` on `/api/`, log redaction of cookies, authorization and setup/CSRF headers;
  - start-up file-permission checks (`security.files` alert);
  - crash handlers (log, then let the service manager restart).
- Details for sites: [security.md](security.md).

### 10.9 Cloud backup targets (Phase 10)

- **Targets:** S3-compatible storage (own SigV4 signer, checked against the AWS test vector) and FTP/FTPS (`basic-ftp`).
- **Licence:** both need the licence feature `backup_cloud`.
- **Upload:** a run is written and verified in `<data>/backup-staging`, then uploaded with the manifest last, checked by listing (count and bytes recorded in `backup_runs.remote_*`), and the staging copy is deleted.
- **Encryption** (optional, recommended): chunked AES-256-GCM with a counter and final-flag in the AAD; the key comes from the passphrase via scrypt, with the salt in `encryption.json`.
- **Restore and full verify:** download (and decrypt) the run plus its base runs into staging (`materializeRun`).
- **Nightly check:** list the objects and compare counts and sizes.
- **Disaster recovery:** `vpm cli backup:download … --kind s3|ftp …` takes the location and the passphrase on the command line.

## 11. Platform matrix

| OS | Package | Service manager | DB |
|----|---------|-----------------|----|
| Windows 10/11, Server 2016+ (x64) | Inno Setup `.exe` (signed) | WinSW | bundled MariaDB 11.4 LTS |
| Ubuntu 22.04 / 24.04 | `.deb`, `install.sh` | systemd | distro MariaDB |
| Debian 12 | `.deb`, `install.sh` | systemd | distro MariaDB |
| RHEL / AlmaLinux 9 | `.rpm`, `install.sh` | systemd | AppStream MariaDB 10.11 |
| Any (optional) | Docker image | — | external DB |

Note: Windows Server 2016's built-in TLS stack is irrelevant here, because Node ships its own OpenSSL.

## 12. Schema overview

| Section | Tables |
|---------|--------|
| Bookkeeping/config | `schema_migrations`, `settings`, `company_profile`, `setup_state`, `app_locks` |
| Identity | `domains`, `users`, `user_recovery_codes`, `addresses` (single namespace), `alias_targets`, `distribution_lists`, `list_members`, `user_groups`, `user_group_members` |
| Access | `sessions`, `ip_allowlist`, `login_attempts` |
| Store | `messages`, `message_search` (FULLTEXT), `folders`, `mail_items`, `mail_item_keywords`, `folder_expunges`, `dedup_ledger` |
| Fetch | `external_accounts`, `external_imap_state`, `external_seen`, `fetch_runs` |
| Relay | `relay_accounts`, `relay_routes`, `outbound_queue`, `outbound_recipients` |
| Jobs | `jobs`, `scheduled_tasks` |
| Rules | `mail_rules`, `forwardings`, `autoreplies`, `autoreply_log`, `journal_rules` |
| Archive | `archive_items`, `archive_item_users`, `retention_policies`, `archive_exports` |
| Backup | `backup_targets`, `backup_schedules`, `backup_runs`, `restore_runs` |
| Security/ops | `tls_certificates`, `audit_log` (hash-chained), `mail_log`, `admin_alerts` |
| Licensing/updates | `license_state`, `license_events`, `update_history` |

The License Server has its own schema in `/license-server/db`, designed in Phase 8.
