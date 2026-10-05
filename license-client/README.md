# /license-client

Licensing inside Vayrone PostMaster. It covers:

- signed licence verification (Ed25519);
- the machine fingerprint;
- online and offline activation;
- the daily heartbeat;
- enforcement modes;
- clock-rollback and tamper checks;
- program-file integrity.

Design: [docs/ARCHITECTURE.md §10](../docs/ARCHITECTURE.md).

| File | Purpose |
|------|---------|
| `format.ts` | Licence, revocation, integrity and request formats; key generation and normalisation. Pure, shared with the License Server. |
| `fingerprint.ts` | Hardware/OS component collection (Linux, Windows) and the one-change-tolerant match. |
| `evaluate.ts` | Pure state machine: active / grace / read-only / evaluation / tampered. |
| `manager.ts` | `LicenseManager`: the `LicenseGate` used by core, web, worker and CLI; activation, heartbeat, offline files, transfer. |
| `integrity.ts` | Verifies `integrity.vsig` in release installs. |
| `keys.ts` | Trusted public keys (managed by `scripts/license-keygen.mjs`). |
| `protocol.ts` | REST types shared with the License Server. |
| `context.ts` | `createLicensedContext()` for the service entry points. |

## Admin panel and CLI

- **Admin → Licence:**
  - status, users used vs licensed, expiry, AMC, machine ID;
  - online activation;
  - "Check now";
  - offline request/import;
  - move to another server.
- **CLI:** `vpm cli license`, `license:activate <key>`, `license:request [key] [file]`, `license:import <file>`, `hwid`.
