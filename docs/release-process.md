# Release process (Vayrone internal)

For Vayrone Infratech engineers who build, sign and publish Vayrone PostMaster. **Never** give the signing key, this repository or build output other than the released packages to clients or partners.

## One-time: signing key

1. On an offline or otherwise trusted machine, run:

   ```sh
   node scripts/license-keygen.mjs vy-2026-1
   ```

   - The private key goes to `~/.vayrone/license-signing-vy-2026-1.pem` (mode 600). It never goes into the repository.
   - The public key is added to `license-client/src/keys.ts`. Commit that change.
2. **Keep two offline backups of the private key** (for example two encrypted USB drives in different places). The same key signs:
   - licences (License Server);
   - integrity manifests;
   - update packages.
3. **Install the key on the License Server.** See [license-server/README.md](../license-server/README.md).
4. **Store the key in CI secrets:** `VPM_SIGNING_KEY` (the PEM) and `VPM_SIGNING_KID`. Optionally add `WIN_CERT_PFX_BASE64` / `WIN_CERT_PASSWORD` for Authenticode signing of `vpm.exe` and the installer.

**Rotating the key:**

1. Create a new kid with the same script; both public keys stay in `keys.ts`.
2. Ship a release.
3. Re-issue licences with the new key (they are re-issued automatically at the next daily heartbeat for online servers).
4. Retire the old key after all offline sites have re-validated.

## Building a release

The executable contains V8 bytecode compiled by the target platform's Node.js. **Linux and Windows builds therefore run on their own platform**, in CI (`.github/workflows/release.yml`).

1. **Prepare the release:**
   - bump `APP_VERSION` in `core/src/migrate.ts`;
   - add database changes as new `db/migrations/NNN_*.sql`, then run `npm run db:schema`;
   - write release notes (plain text) in `release-notes/<version>.txt`.
2. **Check locally:**

   ```sh
   npm test --workspaces
   npm run license-audit
   ```

3. **Tag and push**, for example `git tag v0.4.0 && git push --tags`. CI then:
   1. runs all tests and the licence audit;
   2. on Ubuntu (x64, arm64) and Windows: runs `node scripts/build-release.mjs --format sea --release --sign-key … --kid …`. This:
      - builds the SPA;
      - bundles the server;
      - obfuscates the licensing code;
      - compiles to bytecode;
      - injects the bytecode into the official Node.js 24 binary (checksum-verified);
      - checks that no source, source maps or private keys are included;
      - signs `integrity.vsig`;
   3. runs `npx tsx scripts/make-update.ts …`, which writes the signed `.vpmupdate` and `latest.vidx`;
   4. on Linux: builds `.deb` and `.rpm` (nfpm), `install.sh` and `SHA256SUMS`;
   5. on Windows: downloads WinSW and MariaDB 11.4 (checksum-verified) and builds `VayronePostMaster-Setup-<version>.exe` (Inno Setup).
4. **Test the artifacts** on the test servers (Windows Server 2022, Ubuntu 24.04, AlmaLinux 9):
   - fresh install and setup wizard;
   - upgrade from the previous version with **Admin → Updates** (offline file);
   - IMAP from Outlook, with no re-download after the update.

## Publishing

| Upload | To |
|--------|----|
| `.deb`, `.rpm`, `install.sh`, `SHA256SUMS`, `LATEST` | `https://download.vayrone.com/postmaster/<channel>/` |
| Windows installer | the same folder |
| `dist/updates/<channel>/<target>/` | `https://updates.vayrone.com/postmaster/<channel>/<target>/` |

- **Order:** publish to `beta` first. Promote to `stable` after at least a week without problems, by re-running `make-update.ts --channel stable` on the same release folder.
- **Partners:** tell them about the release, and give offline sites the `.vpmupdate` file.

## What must never ship

The build fails if any of these appear in a release folder:

- `.ts`/`.tsx`/`.cjs` sources, `src/` or `test/` folders, or `.map` files;
- a private key;
- readable JavaScript inside the executable;
- un-obfuscated licensing function names.

`.gitignore` excludes `*.pem`, `*.key` and `release/`.
