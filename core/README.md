# /core — mail engine

SMTP submission, IMAP4rev1 + IDLE, POP3, the single-instance message store, the UID/MODSEQ allocator and the local delivery pipeline. See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

| Path | Contents |
|------|----------|
| `src/store/blobstore.ts` | Content-addressed compressed EML files (atomic write, CRLF normalisation, LRU cache) |
| `src/store/mailstore.ts` | Folders, items, UIDVALIDITY/UID/MODSEQ/UIDL rules, flags, expunge, copy/move, change feed |
| `src/mime/mime.ts` | One-pass MIME indexer: byte offsets, ENVELOPE, BODYSTRUCTURE, dedup content hash |
| `src/mailflow.ts` | Mail flow: rules → atomic delivery → forwards, auto-replies, journaling; LAN submission with outbound rules |
| `src/rules/` | Rule model (zod, shared with the API) and the pure evaluation engine |
| `src/mime/headers.ts` | Header edits: loop markers, DMARC-safe From rewrite for forwards |
| `src/delivery.ts` | Local delivery with per-mailbox dedup; outbound queueing |
| `src/directory.ts` | Domains, users, LAN authentication, address/alias/list resolution |
| `src/smtp/smtp.ts` | Submission on 587 (STARTTLS) / 465 (TLS) |
| `src/imap/*` | Protocol primitives, FETCH, SEARCH, session state machine, listener |
| `src/pop3/pop3.ts` | POP3 with UIDL/TOP/STLS/SASL |
| `src/secrets.ts` | AES-256-GCM credential envelopes; master key from key file (Linux) or DPAPI (Windows) |
| `src/audit.ts` | Hash-chained, append-only admin audit log with verifier |
| `src/settings.ts`, `src/ippolicy.ts` | Security policy (lockout, sessions, 2FA, support access) and LAN IP allowlist |
| `src/license-gate.ts` | Licence enforcement interface (seat limits, read-only mode); real licence in Phase 8 |
| `src/relay.ts`, `src/dsn.ts`, `src/alerts.ts` | Relay resolution/transport, bounce messages, admin alerts |
| `src/main.ts`, `src/cli.ts` | Service entry point and technician CLI |

## Running locally

```sh
cp vpm.config.example.json vpm.config.json   # edit db + ports
npm run cli -- keygen                        # master key for encrypted credentials (dev: auto-created)
npm run cli -- migrate
npm run cli -- domain:add example.lan
npm run cli -- staff:add admin 'Admin#Pass1' super_admin "IT Admin"
npm run cli -- user:add ram@example.lan 'LanPass#1' "Ram Kumar"
npm run dev                                  # starts all listeners
```

## Tests

```sh
npm test            # from /core
```

The test setup needs a MySQL/MariaDB server:

- Set `VPM_TEST_DB_SOCKET` (or `VPM_TEST_DB_HOST`/`_PORT`/`_USER`/`_PASSWORD`) to use an existing server. A database called `vpm_test` is dropped and recreated.
- Otherwise it starts `<repo>/.cache/mysql/bin/mysqld` on a private socket. Put any MySQL 8.x / MariaDB 10.11+ binary tarball there.
- With no database, the integration suites are skipped; the unit tests still run.

| Suite | Covers |
|-------|--------|
| `mime.test.ts`, `protocol.test.ts` | MIME offsets, BODYSTRUCTURE/ENVELOPE encoding, command parser, literals, sequence sets, modified UTF-7 |
| `store.test.ts` | UID never reused, UIDVALIDITY on recreate/rename, MOVE keeps UIDL, dedup, single-instance, counters |
| `imap.test.ts` | Real client (imapflow): STARTTLS, LIST special-use, APPEND/FETCH byte-exact, SEARCH, MOVE, IDLE push from SMTP |
| `compat.test.ts` | Outlook and Thunderbird command transcripts; **switch away and back with a service restart: identical UIDVALIDITY, UIDs and UIDLs** |
| `rules.test.ts`, `mailflow.test.ts` | Conditions, ordering, stop; filing, copies, discard, forwarding (DMARC rewrite, no re-forward on re-download, loops), out-of-office (RFC 3834), journaling, outbound reject over SMTP |
| `pop3-smtp.test.ts` | POP3 UIDL stability, dot-stuffing, DELE/RSET; SMTP auth, sender check, local delivery, relay queue, domain policy |
