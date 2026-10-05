# Vayrone PostMaster — Administrator manual

For the client's mail administrator, who runs the server day to day after installation.

## 1. Signing in

There is one sign-in page for everybody: `https://<server>/`.

- **Mailbox users** land in webmail.
- **Administrators** land in the admin panel. If they also have a mailbox, the switch in the top bar moves between **Mail** and **Admin**.

| Role | Can do |
|------|--------|
| Super admin | Everything, including licence, updates, network, backups and retention |
| Admin | Users, domains, mailboxes, rules, relay, queue; cannot change licence, network or retention |
| Auditor | Read-only access to the archive and the logs |
| User | Own mailbox (webmail or mail programs) |
| Vayrone Support | Technician access for Vayrone, only when the licence includes support and Security allows it. Everything it does is marked in the audit log. |

**Two-step verification (TOTP).** Each user can switch it on under *Account & security → Two-step verification*, using Google Authenticator, Microsoft Authenticator or similar. Security can require it for all administrators.

## 2. Dashboard and System health

- **Dashboard:** users, storage, the outgoing queue, recent sign-ins, and open **alerts**. Acknowledge an alert once someone is handling it.
- **System health:** one tile each for the database, mail disk, outgoing mail, external mailboxes, backups, certificate, server load and licence. Green means fine, amber needs a look soon, red needs action now.
  - **Alert e-mails:** enter one or more addresses. The server checks itself every 5 minutes and mails new problems, repeated once a day while they last. Local mailboxes receive alerts even without internet.
  - **Prometheus / Zabbix:** generate a token; monitoring tools then read `https://<server>/metrics`.

## 3. Domains, users, aliases, groups and lists

- **Domains:** the company's mail domains, for example `company.com`. Each domain has a default quota and decides what happens to mail for unknown addresses: reject it, deliver it to a catch-all mailbox, or relay it to the provider.
- **Users:**
  - **Create:** name, e-mail address and a **LAN password**. This is what the employee types into Outlook; it is *not* their provider password.
  - **Settings:** quota, allowed access (IMAP, POP3, SMTP, webmail), and enabled/disabled.
  - **Seats:** disabled users do not use a licence seat.
- **Aliases:** extra addresses for a mailbox (for example `sales@` → Ravi).
- **Distribution lists:** one address that delivers to several people. Choose who may send to it.
- **Groups:** sets of users for rules, journaling and retention.

## 4. External mailboxes (provider accounts)

Each employee's mailbox at the provider (Zoho, Hostinger, GoDaddy, cPanel, Microsoft 365, …) is connected here. The server fetches its mail into the local mailbox.

| Field | Notes |
|-------|-------|
| User | The local mailbox that receives the mail |
| Protocol | IMAP (preferred) or POP3 |
| Server, port, security | From the provider; presets exist for common providers |
| Username / password | The *provider* login. Stored encrypted; never shown again, and employees never see it. |
| Folders | IMAP only: which provider folders to fetch |
| Interval | How often to check; with IMAP IDLE, new mail arrives within seconds |
| Leave on server | Keep mail at the provider, delete it after fetching, or keep it N days |

Use **Test** to check a connection before saving. The list shows each account's live status. *Wrong password* and *mailbox full* also raise alerts.

**Duplicates are suppressed.** A message fetched twice (for example after a provider-side restore) is delivered only once.

## 5. Outgoing mail: SMTP relay and queue

- **SMTP relay:**
  - **Default relay:** all outgoing mail leaves through one provider account (the relay), while the From address stays the employee's own.
  - **Overrides:** you can send per domain or per user through another account.
  - **Test:** use *Test* to send a real message.
- **Mail queue:** messages waiting to be sent, with the reason they are waiting. You can *Retry now*, *Hold*, *Release* or *Delete* a message.
  - **Retries:** failed messages are retried with growing pauses for 3 days. After that, the sender gets a delivery failure report.

## 6. Mail rules and journaling

- **Mail rules:** global (admin) or per user (webmail → Mail settings).
  - **Conditions:** from, to, cc, subject, body, header, size, attachment or extension, direction, time.
  - **Actions:** move, copy, forward, redirect, auto-reply, reject, discard, flag, mark read, add header, stop.
  - **Order:** drag rules to change the order.
- **Journaling:** a copy of all (or selected) incoming and outgoing mail to another address, for compliance or a manager's review.
- **Loop protection:** forwarding loops between servers are detected automatically.

## 7. Archive (compliance)

When the archive is enabled, every incoming and outgoing message is kept for the retention period (default 7 years), even if users delete it.

- **Who can see it:** auditors and super admins can search by text, sender, recipient, date or direction, open messages, export (MBOX or EML zip) and restore a message into a mailbox. Every access is recorded in the audit log.
- **Legal hold:** keeps a message beyond its retention period.
- **Retention policies:** clean up mailbox folders automatically, for example empty Trash after 30 days.

## 8. Backups and restore

- **Locations:**

  | Kind | Where |
  |------|-------|
  | Folder or USB | Local disk or USB drive |
  | NAS | Windows share (`\\nas\backups`) or NFS |
  | S3 cloud storage | Amazon S3, Wasabi, Backblaze B2, Cloudflare R2, MinIO |
  | FTP/FTPS | An FTP or FTPS server |

  S3 and FTP need the *cloud backup* licence option.
- **Encryption (cloud):** backups are encrypted before upload with a passphrase you choose.
  > **Write the passphrase down and keep it away from the server.** Without it, the backup cannot be restored on a new server. Vayrone cannot recover it.
- **Schedules:** full or incremental at chosen times. *Keep N full backups* removes older ones automatically. The setup wizard creates a weekly full plus nightly incrementals.
- **Checks:** every backup is verified right after it is written, and the newest one again every night. A failed or missing backup raises an alert.
- **Restore** (*Backups → a backup → Restore*): a whole user, one folder, or a date range. Restore into the original folders, or into a *Restored* folder.
  - **No re-download:** message identities are kept, so Outlook does not download everything again.
- **Full server restore** (new hardware, disaster): see [upgrade-guide.md](upgrade-guide.md#restoring-a-whole-server).

## 9. Security

| Setting | Effect |
|---------|--------|
| Lockout | After N wrong passwords, the account is locked for M minutes (applies to webmail, Outlook and phones). |
| Sessions | Idle timeout and maximum session length. *Sessions* lists active sign-ins and can end them. |
| IP allowlist | Limit the admin panel (or IMAP/POP3/SMTP/webmail) to LAN address ranges. |
| Require two-factor for admins | Admins must enrol TOTP before using the admin panel. |
| Vayrone Support access | Allow or block the Vayrone technician account (needs the licence option). |

- **Network & TLS:** server name, ports and the certificate. Before the certificate expires, install a renewed one here (*Install a certificate from a certificate authority*), or create a new self-signed one. Saving restarts the mail services for a few seconds.
- **Logs & audit:**
  - **Mail log:** every delivery, relay attempt, rejection and bounce.
  - **Audit log:** every admin action. It is tamper-evident (hash-chained) and checked every night.

## 10. Licence

**Admin → Licence** shows:

- the plan and the licensed vs. used users;
- the expiry and AMC dates;
- the machine ID.

| Situation | What to do |
|-----------|------------|
| Renewal or upgrade bought | Online: *Check now* (or wait a day). Offline: create a request file, upload it to the Vayrone portal, import the licence file. |
| Server without internet | Re-validate at least every 90 days the same way (a banner reminds you). |
| Moving to new hardware | *Move licence to another server* on the old server, then activate the key on the new one. |
| Licence expired | 15 days of grace with a banner. After that, the admin panel is read-only and new webmail sign-ins are blocked. **Mail keeps flowing in every case.** |

## 11. Updates

**Admin → Updates** (super admin).

- **Online:**
  1. *Check now*, or wait for the daily check.
  2. *Download*.
  3. *Install*.
- **Offline:** upload the `.vpmupdate` file from Vayrone or your partner, then *Install*.

Installing:

1. verifies Vayrone's signature;
2. saves a database snapshot;
3. stops the services for about a minute;
4. replaces the program and checks that the new version starts.

If anything fails, the previous version and database are put back automatically. See [upgrade-guide.md](upgrade-guide.md).

Updates released after the AMC end date need a renewed AMC.

## 12. Company and branding

**Admin → Company:** company name, address, GSTIN, contact and logo (PNG, JPEG or WebP, up to 512 KB). They appear on the sign-in page and in the top bar.

## 13. Everyday checklist

- **Daily:** Dashboard alerts; System health all green.
- **Weekly:** Backups list shows *verified* runs; the outgoing queue is empty or moving; External mailboxes have no errors.
- **Monthly:** Licence and AMC dates; Updates; disk free space trend.
