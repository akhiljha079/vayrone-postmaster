# Third-Party Licences — Vayrone PostMaster

Status: **Phase 3: core, server, worker and web dependencies installed and audited** (`npm run license-audit` passes, 261 packages). Licences were checked against the npm registry on 2026-10-05. Phase 10 regenerates this file from the real installed tree with `npm run license-audit -- --report`. The same script runs in CI and fails the build if a non-allowlisted licence appears.

Policy (spec §11): MIT, MIT-0, BSD-2/3, ISC, Apache-2.0, 0BSD, Zlib, Unlicense and CC0 are allowed. GPL, AGPL, LGPL (static), EUPL and SSPL must be flagged before use. Build-time-only tools that are never shipped to clients are listed separately.

## ⚠ Items that need your decision

| # | Component | Licence | Issue | Recommendation |
|---|-----------|---------|-------|----------------|
| F1 | **MariaDB Server** (bundled in the Windows installer) | GPL-2.0 | We would redistribute GPL binaries. Running it as a separate, unmodified process that we talk to over the network is generally treated as "mere aggregation", so our code stays closed. The obligations are to ship MariaDB's licence text, offer the matching source (or link to it), and not modify it. | **Approve with conditions:** bundle the official unmodified MariaDB ZIP, put `COPYING` + a source link in `licenses/mariadb/`, and run it as its own Windows service. Alternative: the installer downloads the official MariaDB MSI at install time, so we redistribute nothing. Have Indian counsel confirm before the first sale. |
| F2 | **WildDuck** IMAP server (`@zone-eu/wildduck`) | EUPL-1.2 | Copyleft. Reusing its IMAP core would force the product source open. | **Do not use.** IMAP/POP3 will be written in-house (spec §3). `emailjs-imap-handler` (MIT) can be used for command parsing only. |
| F3 | **`@zone-eu/mailsplit`** (pulled in by `mailparser` and `imapflow`) | MIT **OR** EUPL-1.1+ | Dual-licensed. | **Approve:** we take it under MIT. Recorded in `scripts/license-policy.json` via OR-expression handling. |
| F4 | **`mariadb`** npm connector | LGPL-2.1+ | LGPL code inside a single-file SEA binary counts as static linking. | **Do not use.** Use `mysql2` (MIT), which works with both MariaDB and MySQL. |
| F5 | **ClamAV** (optional, Linux only) | GPL-2.0 | Same situation as F1. | **Approve as optional:** we do not bundle it. `install.sh --with-clamav` installs the distro package and we talk to `clamd` over its socket. |
| F6 | **Redis** (optional adapter) | RSALv2 / SSPL / AGPLv3 (Redis 7.4+) | We never ship it, but recommending it to clients carries licence baggage. | Document **Valkey** (BSD-3) as the recommended optional server. The client library `ioredis` is MIT. |
| F7 | **`pkg`** (vercel) | MIT, but **deprecated/archived** | Not a licence issue; it is unmaintained. | Use **Node SEA** (built into Node, MIT) with `postject` (MIT). `@yao-pkg/pkg` (MIT) is the fallback. |
| F8 | **BlueOak-1.0.0** packages (`glob`, `minimatch`, `minipass`, `path-scurry`, `lru-cache`; pulled in by `@fastify/static`) | BlueOak Model License 1.0.0 | Not on the original allowlist (MIT/BSD/Apache/ISC), but it is a permissive licence: commercial use, modification and closed-source redistribution are allowed, with the same notice-keeping duty as MIT, plus an explicit patent grant. | **Treated as allowed** (listed in `scripts/license-policy.json`). Tell me if you want it removed; the alternative is replacing `@fastify/static` with a small in-house static handler. |

## Runtime dependencies (shipped to clients)

| Package | Version checked | Licence | Used in | Purpose |
|---------|-----------------|---------|---------|---------|
| Node.js runtime | 24 LTS | MIT (+ bundled OpenSSL Apache-2.0, ICU Unicode-3.0, libuv MIT, V8 BSD-3) | all | Runtime embedded in the SEA binary. Ship Node's `LICENSE` file. |
| smtp-server | 3.19.x | MIT-0 | core | SMTP submission/LMTP listener |
| nodemailer | 10.0.x | MIT-0 | core, worker | Outbound relay, MIME composition |
| mailparser | 3.9.x | MIT | core, worker | MIME parsing |
| ↳ libmime, libqp, libbase64, he, tlds, linkify-it, html-to-text, encoding-japanese, punycode.js | — | MIT | — | mailparser/imapflow dependencies |
| ↳ @zone-eu/mailsplit | 5.4.x | MIT OR EUPL-1.1+ (we choose MIT) | — | see F3 |
| imapflow | 2.2.x | MIT | worker | External IMAP fetch + IDLE |
| ↳ socks, pino | — | MIT | — | imapflow dependencies |
| ipv6-normalize | 1.0.x | MIT | core | smtp-server dependency |
| mysql2 | 3.24.x | MIT | all | MariaDB/MySQL driver |
| kysely | 0.29.x | MIT | all | Typed SQL query builder |
| fastify | 5.12.x | MIT | server | HTTP API |
| @fastify/static, /cookie, /helmet, /rate-limit | — | MIT | server | Static SPA, cookies, security headers, rate limiting |
| socket.io | 4.8.x | MIT | server, web | Realtime push |
| zod | 4.x | MIT | all | Validation |
| pino | 10.x | MIT | all | Logging |
| otplib | 13.x | MIT | server | TOTP 2FA |
| ↳ @noble/hashes, @scure/base | — | MIT | — | otplib crypto/base32 (audited libraries) |
| qrcode | 1.5.x | MIT | server | TOTP enrolment QR |
| ↳ pngjs, dijkstrajs, yargs, cliui, y18n, yargs-parser, … | — | MIT / ISC | — | qrcode dependencies |
| fastify internals (avvio, find-my-way, pino, light-my-request, secure-json-parse, fast-uri, fastq, …) | — | MIT / BSD-3-Clause / ISC | server | Fastify dependencies |
| @fastify/static → glob, minimatch, lru-cache, minipass, path-scurry | — | BlueOak-1.0.0 | server | see **F8** |
| iconv-lite | 0.7.x | MIT | core | Charset conversion |
| ipaddr.js | 2.5.x | MIT | all | CIDR allowlist matching |
| croner | 10.x | MIT | worker | Cron schedules |
| archiver | 8.x | MIT | worker | ZIP export |
| tar-stream | 3.x | MIT | worker | Backup archives |
| basic-ftp | 6.x | MIT | worker | FTP backup target |
| @aws-sdk/client-s3 | 3.x | Apache-2.0 | worker | S3 backup target (feature-flagged) |
| ioredis | 5.x | MIT | core (used only when `redis.url` is set) | Optional Redis/Valkey event and job bus |
| selfsigned | 5.x | MIT | core | Self-signed TLS certificate on first start |
| ↳ pkijs, asn1js, bytestreamjs | 3.x | BSD-3-Clause | — | selfsigned dependencies |
| ↳ @peculiar/x509, pvtsutils, tsyringe | — | MIT | — | selfsigned dependencies |
| ↳ reflect-metadata | 0.2.x | Apache-2.0 | — | selfsigned dependency |
| ↳ tslib | 2.x | 0BSD | — | selfsigned dependency |
| ↳ long | 5.x | Apache-2.0 | — | mysql2 dependency |
| ↳ split2 | 4.x | ISC | — | pino dependency |
| ~~systeminformation~~ | — | MIT | — | Not used: Phase 8 reads hardware IDs directly (sysfs / CIM), fewer dependencies |
| react, react-dom | 19.x | MIT | web | UI (bundled into the minified SPA) |
| ↳ scheduler | — | MIT | web | React dependency |
| react-router-dom | 7.x | MIT | web | Routing |
| @dnd-kit/core | 6.x | MIT | web | Rule priority drag-and-drop |

Built into Node (no extra dependency): `crypto` (AES-256-GCM, Ed25519, scrypt, SHA-256), `zlib` (gzip/zstd), `tls`, `net`.

## Windows/Linux packaging components (shipped)

| Component | Licence | Notes |
|-----------|---------|-------|
| Node.js 24 runtime | MIT (+ bundled notices in its `LICENSE`) | Embedded in `bin/vpm(.exe)` (Node single executable); its licence ships as `NODEJS-LICENSE.txt`. |
| WinSW 2.12.0 | MIT | Windows service wrapper (`.exe` + XML). Its licence ships as `service\WinSW-LICENSE.txt`. |
| Microsoft Visual C++ runtime DLLs | Microsoft redistributable | Come with the MariaDB Windows ZIP (`msvcp140.dll`, `vcruntime140*.dll`); redistribution with an application is permitted. |
| Inno Setup | Inno Setup Licence (permissive, commercial use allowed) | Only the compiled installer stub is distributed. |
| MariaDB Server 11.4 LTS (Windows ZIP) | GPL-2.0 | See **F1** (approved with conditions). Phase 9 implements them: unmodified binaries from archive.mariadb.org (SHA-256 checked), own service `VayronePostMasterDB`, `COPYING` + `SOURCE.txt` (source link and written offer) in `mariadb\`. Linux uses the distro package. |
| Rspamd (optional, Linux) | Apache-2.0 | Installed from distro/vendor repository, not bundled |

## Build-time only (not shipped)

| Package | Licence |
|---------|---------|
| typescript | Apache-2.0 |
| esbuild | MIT (now a root devDependency; bundles `app/vpm.mjs`) |
| nfpm | MIT (builds `.deb` / `.rpm`) |
| vite | MIT |
| tailwindcss | MIT (its `lightningcss` dependency is MPL-2.0, build-time only) |
| postject | MIT |
| bytenode | MIT |
| javascript-obfuscator | BSD-2-Clause |
| vitest | MIT |
| caniuse-lite | CC-BY-4.0 (browserslist data) |

## Compliance actions for every release

1. `npm run license-audit` passes in CI.
2. `licenses/` folder ships with the product and contains the licence text of every shipped component (MIT/BSD/Apache require it), plus Node's `LICENSE`, plus `licenses/mariadb/COPYING` and a source link.
3. The About page links to "Open-source notices".
