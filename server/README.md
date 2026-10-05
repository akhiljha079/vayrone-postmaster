# /server — web API

Fastify HTTPS API and host for the web SPA (`web/dist`). See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) §9.

| Path | Contents |
|------|----------|
| `src/app.ts` | Plugins (cookies, Helmet CSP, rate limit, static SPA), public branding endpoints |
| `src/sessions.ts` | Opaque session cookie; only its SHA-256 is stored; idle + absolute expiry |
| `src/guards.ts` | Session loading, double-submit CSRF, role levels (`read`/`write`/`super`), admin IP allowlist, mandatory-2FA and licence read-only checks, audit helper |
| `src/routes/auth.ts` | Login, TOTP challenge, logout, `/me`, Mail ↔ Admin mode, own sessions, password change, TOTP enrolment + recovery codes |
| `src/routes/mail.ts` | Mail Mode summary, personal rules, forwarding, out of office |
| `src/routes/webmail.ts` | Webmail: folders, list, read, actions, attachments, compose/send, drafts, uploads, contacts |
| `src/webmail/html.ts`, `src/webmail/compose.ts` | HTML sanitising (sandboxed display), message building and recipient resolution |
| `src/realtime.ts` | Socket.IO push: session-authenticated, per-user rooms, fed by local events and core's IPC stream |
| `src/routes/admin/directory.ts` | Domains, users (licence seats, role rules), aliases, groups, distribution lists |
| `src/routes/admin/relay.ts` | Relay accounts (write-only passwords, test send), routing overrides, queue viewer (retry/hold/release/delete/bulk) |
| `src/routes/admin/system.ts` | Dashboard, all sessions, security policy, IP allowlist, audit log + verification, login history, mail log, alerts, company profile |

## Roles

| Role | Mail Mode | Admin panel |
|------|-----------|-------------|
| `user` | yes | no |
| `auditor` | if it has a mailbox | read-only: dashboard, logs, audit |
| `admin` | if it has a mailbox | read/write; cannot create or modify Super Admins or Vayrone Support |
| `super_admin` | if it has a mailbox | everything, including security policy, IP allowlist, company profile |
| `vayrone_support` | no | admin-level, **only** when the site enables it (and the licence includes it); hidden from normal admins; every action is flagged in the audit log |

## Run / test

```sh
npm run dev     # needs VPM_CONFIG; serves https://<listenHost>:<web.port>
npm test        # fastify.inject tests; uses the shared test database (see core/README.md)
```
