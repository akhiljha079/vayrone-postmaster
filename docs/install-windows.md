# Installing Vayrone PostMaster on Windows

For the person installing the mail server at a client site: Vayrone or partner technicians, or the client's IT administrator.

## Before you start

| Item | Requirement |
|------|-------------|
| Windows | Windows Server 2016, 2019, 2022 or 2025; or Windows 10/11 Pro (64-bit) |
| CPU and memory | 4 cores and 8 GB RAM (up to about 200 users); 8 cores and 16 GB for 500 users |
| Disk for mail | An SSD with about 1 GB per user per year, plus room for growth |
| Disk for backups | A second disk, USB drive, NAS share or cloud bucket. Never only the mail disk. |
| Network | A fixed LAN IP address, and a name for the server (for example `mail.company.local`) in DNS or each PC's hosts file |
| Licence | The licence key (`VPM-…`) from Vayrone Infratech or your partner. Without it, the server runs a 30-day, 5-user evaluation. |
| Accounts | The provider account used for sending (for example `mailserver@company.com`), and each employee's provider mailbox password (entered once, then stored encrypted) |

**Ports.** The installer opens these on the Windows Firewall for the *domain* and *private* network profiles only:

| Port | Used by |
|------|---------|
| 443 (or 8443) | Web admin and webmail |
| 587, 465 | Sending mail (SMTP) |
| 143, 993 | IMAP |
| 110, 995 | POP3 |

If IIS or another web server already uses port 443, the installer suggests 8443.

## Install

1. **Run the installer.** Run `VayronePostMaster-Setup-<version>.exe` as an administrator.
2. **Accept the licence agreement.**
3. **Choose the program folder.** The default is `C:\Program Files\Vayrone PostMaster`.
4. **Choose the mail data folder.** Put it on the large SSD. Mail, the database and the search index live here.
5. **Choose the HTTPS port** for the web admin.
6. **Let the installer set up the server.** It:
   - sets up the bundled database (service *Vayrone PostMaster Database*, listening only on 127.0.0.1:3307);
   - creates the encryption key, protected by Windows (DPAPI);
   - starts the services *Vayrone PostMaster*, *Vayrone PostMaster Worker* and *Vayrone PostMaster Updater*;
   - opens the firewall ports.
7. **Finish.** The browser opens the **setup wizard** at `https://localhost/setup`, or `https://localhost:8443/setup`.

The browser warns about the certificate the first time. This is expected; a self-signed certificate is created for you. Continue to the page.

## Setup wizard

| Step | What to enter |
|------|---------------|
| 1. Licence | The licence key; the server must reach the internet for a moment. Without internet, choose *Offline activation*, download the request file, upload it at `https://license.vayrone.com/portal` from any PC, and import the licence file you get back. |
| 2. Company | Name, address, GSTIN, contact, logo. Shown on the login page; sent to Vayrone with the activation. |
| 3. Mail domains | For example `company.com`. |
| 4. Super admin | The first administrator. Keep the password safe. |
| 5. Relay | The provider's SMTP server and the sending account. Use *Send test* to a real address. |
| 6. Network | Server name, ports, and the TLS certificate (keep the self-signed one, or upload your own). |
| 7. Storage and backup | The backup folder (second disk, USB or `\\nas\share`), backup time, archive retention, when Trash and Junk are emptied. |
| 8. Summary | *Finish*. If you changed ports or the certificate, the services restart and the browser moves to the new address. |

To open the wizard from another PC, use `https://<server-ip>/setup?token=<token>`. The token is shown in the Start menu under *Show setup wizard address*.

## After setup

- **Users:** create users (Admin → Users) and connect their provider mailboxes (Admin → External mailboxes).
- **Mail programs:** set up Outlook or Thunderbird on each PC; see [mail-clients.md](mail-clients.md).
- **Alerts:** in Admin → System health, enter an e-mail address for alerts.
- **Backups:** the next morning, check that the first backup succeeded (Admin → Backups).

## Where things are

| What | Where |
|------|-------|
| Program | `C:\Program Files\Vayrone PostMaster` (`bin\vpm.exe`, `db`, `web`, `mariadb`, `service`) |
| Configuration and encryption key | `C:\ProgramData\Vayrone PostMaster` (Administrators only) |
| Database root password (for Vayrone support) | `C:\ProgramData\Vayrone PostMaster\mariadb-root.txt` |
| Mail, database, logs | The data folder you chose; logs in `<data>\logs` |
| Command line | Start menu → *Vayrone PostMaster command prompt*, then `vpm cli help` |

## Uninstalling

*Settings → Apps → Vayrone PostMaster → Uninstall* removes the program, the services and the firewall rule.

**Mail, the database and the configuration are kept.** Delete the data folder and `C:\ProgramData\Vayrone PostMaster` yourself, only when the mail is truly no longer needed.

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| Browser cannot open the admin page | Is the *Vayrone PostMaster* service running (`services.msc`)? Is the port right? Look in `<data>\logs\VayronePostMaster.out.log`. |
| Service stops right after starting | Look in the same log. Typical causes: another program uses a mail port (change the port in Admin → Network & TLS, or stop the other program), or the database service is stopped. |
| Port 443 in use | Use 8443, or stop the other web server. |
| PCs cannot reach the server | Windows Firewall on a *public* network profile: set the network to *private*, or allow the ports for the public profile. |
