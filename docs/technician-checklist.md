# Technician checklist: installing Vayrone PostMaster at a client site

For Vayrone Infratech and partner technicians. Tick every line; leave a copy with the client.

## Before the visit

- [ ] **Licence:** licence key issued on the License Server for the right client, plan and user count. For an offline site, the client knows to send the request file to Vayrone (e-mail or WhatsApp) and import the .vlic file they get back.
- [ ] **Installer:** latest installer or package plus `SHA256SUMS` on a USB stick. Checksum verified.
- [ ] **Provider details from the client:**
  - [ ] mail domain(s);
  - [ ] the SMTP relay account (for example `mailserver@company.com`) and its password;
  - [ ] a list of employees with their provider mailbox addresses (passwords are typed in on site by the client, or by you with the client present).
- [ ] **Server hardware:** 4+ cores, 8+ GB RAM, SSD for mail, second disk/NAS/USB/cloud bucket for backups, UPS.
- [ ] **Network:** fixed IP agreed; DNS name agreed (for example `mail.company.local`) or hosts-file entries planned.

## Installation

- [ ] **OS:** updated, correct time zone, time sync on (licensing checks the clock).
- [ ] **Installed:** [install-windows.md](install-windows.md) / [install-linux.md](install-linux.md).
- [ ] **Setup token:** setup address and token noted.
- [ ] **Setup wizard:**
  - [ ] licence activated (online, or offline file imported);
  - [ ] company details and logo;
  - [ ] domains;
  - [ ] super admin (password handed to the client's responsible person, not kept by you);
  - [ ] relay account: **test message received** at an outside address;
  - [ ] server name and certificate: self-signed, or the client's certificate installed;
  - [ ] backup location and time; archive retention as agreed.
- [ ] **Alerts:** Admin → System health → alert e-mail set to the client's IT contact (and the partner, if agreed).
- [ ] **Two-step verification:** Admin → Security → *Require two-step verification for admins* (recommended).
- [ ] **Admin access by IP:** Admin → Security → IP allowlist: admin panel limited to the IT team's addresses (recommended).

## Users and mailboxes

- [ ] **Users** created with LAN passwords; the initial password list is handed over securely.
- [ ] **External mailboxes** connected for every user. All show *OK* (no *wrong password* or *backoff*).
- [ ] **Leave on server** chosen with the client (keep N days recommended).
- [ ] **One real test mail per direction:**
  - [ ] outside → user (arrives within seconds with IDLE, otherwise at the polling interval);
  - [ ] user → outside (From is the user's own address);
  - [ ] user → colleague (internal).

## Mail programs

- [ ] Certificate trusted on PCs (Group Policy, or per PC; see [mail-clients.md](mail-clients.md)).
- [ ] Outlook/Thunderbird set up with **IMAP** on each PC; old `.pst` data moved if needed.
- [ ] Phones (on office Wi-Fi/VPN) set up if requested.
- [ ] Webmail tested by at least one user.

## Before leaving

- [ ] **Back up now** succeeded and shows *verified* (Admin → Backups).
- [ ] **Encryption passphrase** (cloud backups) written down **by the client** and stored off-site.
- [ ] **Master key and config copied** for disaster recovery, stored with the client's IT records, not on the server alone:
  - Linux: `/etc/vayrone-postmaster/master.key` and `vpm.config.json`;
  - Windows: `C:\ProgramData\Vayrone PostMaster\vpm.config.json` and `mariadb-root.txt`.
- [ ] **System health:** all tiles green or explained.
- [ ] **Licence page:** users used vs licensed is correct; AMC date explained to the client.
- [ ] **Client trained:** adding a user, connecting an external mailbox, reading alerts, restoring a folder from backup.
- [ ] **Handover:** site details recorded in the License Server (client notes: server name, IP, admin contact).
