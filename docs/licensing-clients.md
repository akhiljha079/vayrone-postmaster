# Licensing clients (Vayrone internal)

For Vayrone Infratech staff who sell and issue PostMaster licences. **Never** give clients or partners the signing key or this document.

## The pieces

| Piece | Where |
|-------|-------|
| **Private signing key** `vy-2026-1` | `~/.vayrone/license-signing-vy-2026-1.pem` on the build Mac, plus two offline backups. Also needed on the License Server. |
| **Public key** | Built into every PostMaster release (`license-client/src/keys.ts`). A licence signed with any other key is rejected. |
| **License Server** | Fastify + MySQL + admin panel, deployed on the Vayrone VPS. See [license-server/README.md](../license-server/README.md). Online servers activate and send heartbeats here. Offline request files are processed by Vayrone staff in the vayrone.com admin panel (Licensing → Offline licence file). |

## Normal way: License Server

One-time setup on the VPS:

```sh
export LS_CONFIG=/etc/vayrone-ls/config.json   # signingKeyFile -> copy of the .pem, kid vy-2026-1
vls-cli migrate
vls-cli owner:add owner@vayrone.com '<strong password>' "Owner"
vls-cli plans:seed      # Starter / Business / Enterprise / Perpetual. Check prices in Plans before selling.
```

For each sale (admin panel, or CLI):

```sh
vls-cli client:add --company "Agra Steel Traders" --email it@agrasteel.com --city Agra --gstin 09ABCDE1234F1Z5
vls-cli license:create --client 12 --plan business --users 50 --months 12 --amount 45000 --invoice VI/26-27/031
# -> prints the key VPM-XXXXX-XXXXX-XXXXX-XXXXX-X : give it to the client or technician
```

Then, depending on whether the client's server has internet:

- **Online:** the setup wizard (or Admin → Licence) activates the key directly. Renewals and upgrades made on the License Server reach the server at its next daily heartbeat.
- **Offline:**
  1. The client downloads a request file (`.vreq`) from Admin → Licence → *Offline activation*.
  2. The client sends it to Vayrone (e-mail or WhatsApp). Process it in vayrone.com → Admin → Licensing → **Offline licence file**, and send back the `.vlic` file. Without the website you can also run:

     ```sh
     vls-cli license:offline postmaster-request-XXXXX.vreq --out agrasteel.vlic
     ```

  3. The client imports the `.vlic` file in Admin → Licence.
  4. They repeat this at least every 90 days, or when they renew.

**Moving to new hardware:**

- **Online:** the client clicks *Move licence to another server*.
- **Offline:** release the activation in the License Server admin panel, then process the new machine's request.

## Emergency way: signing key only

Use this when the License Server is unavailable, or for a one-off site. It issues a licence file straight from a request, with no database. The License Server will not know about it: record it by hand, then re-create it on the License Server later.

```sh
npx tsx license-server/src/cli.ts license:issue-file postmaster-request-XXXXX.vreq \
  --key ~/.vayrone/license-signing-vy-2026-1.pem --kid vy-2026-1 \
  --client "Agra Steel Traders" --plan business --plan-name Business \
  --users 50 --months 12 --amc-months 12 \
  --features archive,backup_cloud,antivirus,external_fetch \
  --out agrasteel.vlic
```

| Option | Meaning |
|--------|---------|
| `--perpetual` | No expiry. Use it instead of `--months`. |
| `--offline-days` | How long before the server must re-validate (default 365 for file licences). |
| `--features` | Comma-separated. Choose from `archive`, `backup_cloud`, `antivirus`, `support_access`, `journaling`, `external_fetch`. |

## Demo run (2026-10-06)

A test instance on the build Mac went through the whole flow with the production key:

1. **Start:** a fresh install, `unlicensed`, with the 5-user evaluation limit.
2. **Request:** it created the offline request `postmaster-request-62BPT-98A18.vreq` for key `VPM-2NQKW-XATGS-CHSJC-JQEDF-P`.
3. **Sign:** `license:issue-file` signed licence `LIC-2026-F834270`:
   - Demo Client (Vayrone Infratech), Business, 50 users, 12 months;
   - features: archive, backup_cloud, antivirus, external_fetch.
4. **Import:** the instance verified the signature (kid `vy-2026-1`) and the machine match (os, board, uuid, cpu).
5. **Result:** status **active**, 50 users, "Licensed to Demo Client (Vayrone Infratech) — Business, 50 users".

That licence is bound to the build Mac, so it is not usable on any other machine. A real client's licence must be made from **their** server's request file, or with `license:create` and online activation.
