# Vayrone PostMaster — Deployment guide

For the client's management and IT person. It covers planning, installation, migrating employees and going live. Your Vayrone technician or partner normally does this with you. Detailed steps are in the linked documents.

## 1. What you get

Vayrone PostMaster is a mail server inside your office.

- **Mail stays with your provider.** Every employee keeps their mailbox at your current provider (Zoho, Hostinger, GoDaddy, cPanel, Microsoft 365, …).
- **The server collects it.** PostMaster fetches each employee's mail into a local mailbox within seconds.
- **Employees use the office server.** They read and send through it from Outlook, Thunderbird, phones or webmail, with a **LAN password**. They never see the provider password.
- **Outgoing mail** leaves through one provider account. Each person's own address stays the sender.
- **The office server also provides:**
  - spam, virus and dangerous-attachment filtering;
  - a compliance archive (default 7 years);
  - backups to a disk, NAS or cloud;
  - alerts;
  - automatic updates.

**Mail is never lost when the server is busy, being updated or switched off.** It stays at the provider and is fetched once the server is back.

## 2. Plan

### 2.1 Server

| Office size | CPU | RAM | Mail disk (SSD) | Operating system |
|-------------|-----|-----|-----------------|------------------|
| Up to 50 users | 4 cores | 8 GB | 500 GB | Windows Server 2019/2022/2025, Windows 10/11 Pro, Ubuntu 22.04/24.04, Debian 12, RHEL/AlmaLinux/Rocky 9 |
| 50–200 users | 4–8 cores | 16 GB | 1–2 TB | same |
| 200–500 users | 8 cores | 16–32 GB | 2–4 TB | Linux recommended |

- **Mail disk size:** plan about **1 GB per user per year**, plus the archive.
- **Backups:** add a **second disk, NAS or cloud bucket**. A backup on the mail disk does not protect against disk failure.
- **Power:** use a **UPS**; sudden power loss is the most common cause of trouble.

Tested sizing: on a 2013-era quad-core i7 laptop, the full target ran in one process, sharing the CPU with the test clients and database (production splits this work across separate services):

- 500 users and 1000 external mailboxes;
- 3000 messages fetched in 29 seconds;
- new provider mail reached the local mailbox in under 1 second, with all 1000 mailboxes watched live;
- new mail pushed to connected mail programs in about 0.4 seconds, with 500 connected;
- about 300 MB of memory.

See [performance.md](performance.md).

### 2.2 Network

- **Fixed IP:** give the server a fixed LAN IP address, for example `192.168.1.10`.
- **Server name:** choose one such as `mail.company.local`. Add it to your DNS server, or to each PC's hosts file.
- **Internet access:** the server needs outgoing access to your mail provider (IMAP 993 / POP3 995, SMTP 465 or 587). Online licence activation and updates also use the internet; if the server has none, use offline files instead.
- **Inbound ports:** do **not** open any ports from the internet. Phones outside the office use your VPN.

### 2.3 Information to collect

| Item | From |
|------|------|
| Licence key `VPM-…` | Vayrone Infratech or your partner |
| Mail domain(s), e.g. `company.com` | You |
| The **relay account** for sending, e.g. `mailserver@company.com`, with its password | Your mail provider / IT. Create it if needed. |
| List of employees: name, e-mail address, provider mailbox password | You. Passwords are typed into the admin panel once, then stored encrypted. |
| A backup location | Second disk, USB drive, NAS share (`\\nas\backup`), or a cloud bucket (Amazon S3, Wasabi, Backblaze, …) |
| Who receives alerts | IT person's e-mail address |

## 3. Install

- **Windows:** run `VayronePostMaster-Setup-<version>.exe`. The installer adds the database, three services and the firewall rules. See [install-windows.md](install-windows.md).
- **Linux:**

  ```sh
  curl -fsSL https://download.vayrone.com/postmaster/install.sh | sudo sh -s -- --with-clamav
  ```

  `--with-clamav` adds the ClamAV virus scanner; `--with-rspamd` adds a stronger spam filter on Ubuntu/Debian. Without internet, copy the package and run `sudo sh install.sh --package <file>`. See [install-linux.md](install-linux.md).

At the end, the browser opens the **setup wizard**. It walks through eight steps:

1. **Licence:** enter the key. Without internet: *Offline activation* → download the request file → send it to Vayrone or your partner (e-mail or WhatsApp) → import the licence file you get back.
2. **Company:** name, address, GSTIN, logo. These appear on the sign-in page.
3. **Mail domains.**
4. **Super administrator:** the first admin. Keep its password safe.
5. **Relay account:** use *Send test* and confirm the test mail arrives.
6. **Network and certificate:** the server name, and the certificate (keep the self-signed one, or upload your company's).
7. **Storage and backup:** backup folder and time, archive retention, Trash/Junk cleanup.
8. **Finish.**

## 4. Configure

1. **Users** (Admin → Users): one per employee, with a **LAN password**, the one they will type in Outlook.
2. **External mailboxes** (Admin → External mailboxes): for each user, connect their provider mailbox (IMAP preferred).
   - **Provider settings:** choose the provider preset, then enter the provider password.
   - **Test:** click *Test* before saving.
   - **Leave on server:** *keep 14 days* is a safe start. Mail stays at the provider for two weeks, so phones that still read the provider directly keep working during the change-over.
   - **Status:** all accounts should turn *OK* within a minute.
3. **Spam and viruses** (Admin → Spam & quarantine):
   - **Spam:** the built-in spam check is on.
   - **Viruses:** choose ClamAV if it was installed, and click *Test with the EICAR test file*.
   - **Attachments:** dangerous attachments (`.exe`, `.js`, …) are held in quarantine by default.
4. **Alerts** (Admin → System health): enter the IT person's address and send a test alert.
5. **Security** (Admin → Security):
   - require two-step verification for administrators;
   - limit the admin panel to IT's IP addresses.

## 5. Move employees to the office server (go-live)

Do this department by department, or all at once on a quiet day.

1. **Install the server certificate on each PC** (once, by Group Policy or by hand). This applies only if the server uses a self-signed certificate. See [mail-clients.md](mail-clients.md#trusting-the-servers-certificate-self-signed).
2. **In Outlook / Thunderbird, add the office account** (IMAP, `mail.company.local`, LAN password). See [mail-clients.md](mail-clients.md).
   - The office account receives everything the server fetched: by default, the provider's mail from the moment the account was connected, and older mail too if you chose to fetch it.
   - Keep the old provider account in Outlook for a week if people need its history. Then move the old folders into the new account (drag and drop), or export them to a `.pst` file, and remove the old account.
3. **Phones:** set up the office account (inside the office or over VPN). Alternatively, keep the provider account on phones; mail stays at the provider for the *leave on server* period.
4. **Check:**
   - each person can **receive** (send them a test from outside) and **send** (reply to an outside address; the recipient sees the person's own address);
   - mail between colleagues arrives instantly.

## 6. After go-live

| When | Check |
|------|-------|
| Next morning | Admin → Backups shows a *verified* backup; System health is green |
| First week | Admin → External mailboxes has no errors; Spam & quarantine has nothing wrongly held (release false alarms) |
| Monthly | Licence and AMC dates (Admin → Licence); Updates; free disk space trend |

**Keep these off the server, in a safe place:**

- the super admin password;
- the backup encryption passphrase (cloud backups);
- a copy of the configuration and encryption key:
  - Linux: `/etc/vayrone-postmaster/`;
  - Windows: `C:\ProgramData\Vayrone PostMaster\`.

You need them to rebuild the server after a hardware failure ([upgrade-guide.md](upgrade-guide.md#restoring-a-whole-server)).

## 7. Updates, licence and support

- **Updates:** Admin → Updates → *Check now* → *Download* → *Install*. Updates are signed by Vayrone, take about a minute, back up the database first, and roll back by themselves if anything fails. Offline sites upload the update file from Vayrone.
- **Licence:**
  - **Online servers:** renew through Vayrone or your partner; online servers pick up the renewal within a day.
  - **Offline servers:** re-validate every 90 days with a request file (a banner reminds you).
  - **After expiry:** you get 15 days of grace. After that, the admin panel is read-only — **mail keeps flowing**.
- **Moving to new hardware:** Admin → Licence → *Move licence to another server* on the old server, then activate the key on the new one.
- **Support:** Vayrone Infratech, Agra, or your partner. Have the version (page footer → *About*) and the machine ID (Admin → Licence) ready.

## Documents

| Topic | Document |
|-------|----------|
| Windows installation | [install-windows.md](install-windows.md) |
| Linux installation | [install-linux.md](install-linux.md) |
| Outlook, Thunderbird, phones | [mail-clients.md](mail-clients.md) |
| Day-to-day administration | [admin-manual.md](admin-manual.md) |
| Updates and disaster recovery | [upgrade-guide.md](upgrade-guide.md) |
| Security settings | [security.md](security.md) |
| Technician checklist | [technician-checklist.md](technician-checklist.md) |
