# Upgrading Vayrone PostMaster

For client administrators and Vayrone technicians.

## What every update does

Whichever way you install it, an update:

1. verifies that the package is signed by Vayrone Infratech and made for this platform and version;
2. saves a **database snapshot** in `<data>/updates/pre-update/` (the last three are kept);
3. stops the mail services, replaces the program files (the old ones are kept in `<install folder>/.rollback`), and starts the services;
4. lets the services upgrade the database themselves (numbered migrations, each applied once);
5. waits until the new version answers.

**If any step fails**, the old program files are put back, the database snapshot is restored if the database had already changed, and the old version starts again. *Admin → Updates → history* shows each step.

**Downtime** is usually under a minute. Outlook, Thunderbird and phones reconnect by themselves, and mail from providers is fetched again afterwards, so **nothing is lost**: mail that arrives at the provider during the update is fetched once the worker is back.

**Licence:** updates released after your AMC end date need a renewed AMC. Evaluation installs can always update.

## One-click update (server with internet)

1. Go to **Admin → Updates** and click *Check now* (the server also checks daily).
2. Read the release notes, then click *Download*. The file is checked against the signed index.
3. Click **Install** and confirm. The page follows the progress and reconnects when the new version is up.

The *Beta* channel gets new versions earlier. Use it on a test server, not in production.

## Offline update (server without internet)

1. Get the update file `vayrone-postmaster-<version>-<platform>.vpmupdate` from Vayrone or your partner. Use `win-x64` for Windows and `linux-x64` for most Linux servers.
2. Go to **Admin → Updates → Offline update file** and choose the file. It is verified on upload.
3. Click **Install**.

## Updating with the installer or package manager

You can also update by running the new installer, which keeps data and settings:

- **Windows:** run the new `VayronePostMaster-Setup-<version>.exe`. It stops the program services, replaces the files and starts them; the database engine is not touched.
- **Linux:** `sudo apt install ./vayrone-postmaster_<version>-1_amd64.deb`, or `sudo dnf install ./vayrone-postmaster-<version>-1.x86_64.rpm`, or `sudo sh install.sh --package <file>`.

These routes take no automatic database snapshot. **Run a backup first** (Admin → Backups → *Back up now*).

## If something goes wrong

- **Update history shows *Rolled back*:** the old version is running again. Send the log shown under the update to Vayrone support.
- **Update history shows *Failed* and the admin panel does not open:**
  - The old files are in `<install folder>/.rollback` and the database snapshot is in `<data>/updates/pre-update/`.
  - The updater log is `<data>/updates/update.log`.
  - Contact Vayrone support; do not delete these folders.
- **The update stays on *Verifying*:** the updater is not running.
  - **Linux:** `systemctl status vayrone-postmaster-updater.path`.
  - **Windows:** the *Vayrone PostMaster Updater* service.

## Restoring a whole server

Use this for new hardware or after a disk failure.

1. Install the **same or a newer** version of Vayrone PostMaster on the new server, but **do not** finish the setup wizard.
2. Make the backup reachable:
   - **Folder, USB or NAS:** connect it.
   - **Cloud backups:** download the newest backup folder into a local folder. You need the bucket details, the access key and the encryption passphrase:

     ```sh
     vpm cli backup:download vpm-incremental-20260412-010000-r812 D:\restore ^
       --kind s3 --endpoint https://s3.ap-south-1.amazonaws.com --region ap-south-1 ^
       --bucket company-mail-backup --prefix postmaster --access-key AKIA… --secret-key … ^
       --passphrase "…"
     ```

     The folder names are listed in the bucket (or on the old server under Admin → Backups). The base full backup of an incremental is downloaded with it.
3. Stop the services:
   - **Windows:** `sc stop VayronePostMasterWorker`, then `sc stop VayronePostMaster`.
   - **Linux:** `sudo systemctl stop vayrone-postmaster vayrone-postmaster-worker`.
4. Restore:

   ```sh
   vpm cli restore-full <backup folder>
   ```

   This restores all users, mailboxes, settings and mail, with the same message identities, so mail programs do **not** download everything again.
5. Start the services again.
6. Activate the licence on the new hardware: **Admin → Licence → Move licence**, or ask Vayrone to release the old machine.
7. If the old server's master key is lost, re-enter the provider passwords in Admin → External mailboxes and the relay password in Admin → SMTP relay. They were encrypted with the old key.

**Keep the master key with your backups:** `/etc/vayrone-postmaster/master.key` on Linux. On Windows the key is tied to the machine, so after a hardware move, re-enter the stored passwords as in step 7.
