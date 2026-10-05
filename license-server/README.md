# Vayrone License Server

A separate web app, hosted by Vayrone Infratech, that issues and tracks Vayrone PostMaster licences:

- clients, plans, licence keys, activations and machine transfers;
- renewals and AMC;
- partners (resellers);
- offline activation;
- expiry reminders;
- usage reports.

It has its own MySQL database and does not need the mail engine. It uses only `@vpm/license-client/format`, `/fingerprint` and `/protocol`.

Design: [docs/ARCHITECTURE.md §10.5](../docs/ARCHITECTURE.md).

## Deploy on the Vayrone VPS (aaPanel)

1. **Database.** In aaPanel → Databases, create a MySQL database (e.g. `vayrone_license`) and a user for it.

2. **Signing key.** Create it once, on a trusted machine, from the PostMaster repository:
   ```sh
   node scripts/license-keygen.mjs vy-2026-1
   ```
   - This writes the private key to `~/.vayrone/license-signing-vy-2026-1.pem` (mode 600).
   - It also adds the public key to `license-client/src/keys.ts`, so product builds trust it.
   - Copy the `.pem` to the server, for example `/www/vls/keys/`, owned by the service user, with `chmod 600`.
   - Keep an offline backup of the key. If it is lost, every issued licence must be re-issued after shipping a new public key.

3. **Settings encryption key.**
   ```sh
   npx tsx src/cli.ts secret:gen /www/vls/keys/secret.key
   ```

4. **Config file.** Write `/www/vls/license-server.config.json`:
   ```json
   {
     "db": { "host": "127.0.0.1", "user": "vls", "password": "…", "database": "vayrone_license" },
     "port": 7780,
     "publicUrl": "https://license.vayrone.com",
     "signingKeyFile": "/www/vls/keys/license-signing-vy-2026-1.pem",
     "signingKeyId": "vy-2026-1",
     "secretKeyFile": "/www/vls/keys/secret.key",
     "webRoot": "/www/vls/app/license-server/web/dist",
     "migrationsPath": "/www/vls/app/license-server/db"
   }
   ```

5. **Build and initialise:**
   ```sh
   npm ci
   npm run build -w license-server
   LS_CONFIG=/www/vls/license-server.config.json npx tsx license-server/src/cli.ts migrate
   LS_CONFIG=… npx tsx license-server/src/cli.ts owner:add you@vayrone.com '<password>' 'Your Name'
   ```

6. **Run it.** In aaPanel → Website → Node project:
   - start command: `npx tsx license-server/src/main.ts`;
   - environment: `LS_CONFIG=/www/vls/license-server.config.json`;
   - Node 24.

7. **Reverse proxy.** Add a site `license.vayrone.com` that proxies to `http://127.0.0.1:7780`, with a Let's Encrypt certificate.
   - The service listens on 127.0.0.1 only.
   - `trustProxy` is on, so client IPs come from nginx.

8. **Settings.** Sign in, then:
   - in Settings, fill in Email (SMTP), WhatsApp and the reminder days;
   - create plans, partners, then staff and partner logins.

9. **Product side.** The product's default server URL is `https://license.vayrone.com`. Point it elsewhere with `license.serverUrl` in `vpm.config.json`.

### Backups

Back up three things together:

- the database;
- `secret.key`, needed to read the stored SMTP/WhatsApp credentials;
- the signing key, kept offline.

## Customer offline portal

Offline customers use `https://license.vayrone.com/portal`:

1. Upload the request file from the server's Licence page.
2. Download the licence file.

Staff and partners can also process requests in the admin UI under **Offline files**, where they see the request details before issuing.

## Development

```sh
LS_CONFIG=./license-server.config.json npm run dev -w license-server   # API on :7780
npm run dev:web -w license-server                                       # UI with /api proxied
npm test -w license-server                                              # uses the test MySQL from core/test
```

For a local product to trust a development License Server, copy its **public** key to `<product dataPath>/dev-license-keys/<kid>.pem`. Only development builds read that folder.
