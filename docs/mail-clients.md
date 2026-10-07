# Setting up Outlook, Thunderbird, phones and webmail

For the IT person setting up employees' computers and phones.

Each employee signs in to the **office mail server** with their **LAN password**, set in Admin → Users. They never need, and never see, the password of their provider mailbox.

## Server settings

Replace `mail.company.local` with your server's name (or IP address).

| | Server | Port | Security |
|---|--------|------|----------|
| Incoming, **IMAP** (recommended) | mail.company.local | 993 | SSL/TLS |
| | | 143 | STARTTLS |
| Incoming, POP3 | mail.company.local | 995 | SSL/TLS |
| | | 110 | STARTTLS |
| Outgoing (SMTP) | mail.company.local | 465 | SSL/TLS |
| | | 587 | STARTTLS |
| User name | the full e-mail address, e.g. `ravi@company.com` | | |
| Password | the LAN password | | |
| Outgoing server requires sign-in | **yes**, same user name and password | | |

**Use IMAP** so that mail, folders and read/unread state are the same in Outlook, on the phone and in webmail.

## Trusting the server's certificate (self-signed)

If the setup wizard kept the self-signed certificate, Outlook and phones ask once whether to trust it. To stop the question on each PC, install the certificate once:

1. On the PC, open `https://mail.company.local/api/public/certificate`. This downloads `mail.company.local.crt`.
2. Double-click the file → *Install Certificate* → *Local Machine* → *Place all certificates in the following store* → **Trusted Root Certification Authorities** → *Finish*.
3. Restart Outlook.

For many PCs, an administrator can distribute the same file through Group Policy: *Computer Configuration → Policies → Windows Settings → Security Settings → Public Key Policies → Trusted Root Certification Authorities*.

With a certificate from a public authority (uploaded in the setup wizard), none of this is needed.

## Outlook (Microsoft 365 / 2021 / 2019 / 2016, classic)

1. *File → Add Account*, type the e-mail address, then *Advanced options → Let me set up my account manually → IMAP*.
2. Incoming: `mail.company.local`, port 993, *SSL/TLS*. Outgoing: `mail.company.local`, port 465, *SSL/TLS* (or 587, *STARTTLS*).
3. Enter the LAN password. Accept the certificate question if it appears.

**Switching an existing Outlook profile:** if Outlook was connected directly to the provider before, add the office server as a new account. Then move old local mail (in a `.pst` file) into it if needed.

**Mail is never downloaded twice.** Message identities are stable across backups, restores and updates, so re-adding the account or restoring the server does not make Outlook download everything again.

## New Outlook for Windows

*Settings → Accounts → Add account → IMAP*. Use the same values. New Outlook needs the certificate installed (see above) when it is self-signed.

## Thunderbird

1. *Account Settings → Account Actions → Add Mail Account*, then enter name, address and LAN password.
2. Click *Configure manually*. IMAP: `mail.company.local`, 993, SSL/TLS, *Normal password*. SMTP: `mail.company.local`, 465, SSL/TLS, *Normal password*.
3. *Done*. On the certificate question, choose *Permanently store this exception*.

## Phones (on the office Wi-Fi or VPN)

- **iPhone:** *Settings → Mail → Accounts → Add Account → Other → Add Mail Account*. Choose IMAP with the values above. With a self-signed certificate, first install the certificate profile from `https://mail.company.local/api/public/certificate`, then enable it under *Settings → General → About → Certificate Trust Settings*.
- **Android (Gmail app):** *Add another address → Other → Personal (IMAP)*. Use the values above and accept the certificate.

The server is on the office LAN. Outside the office, phones reach it only through the company VPN, if one is set up.

## Webmail

Any browser: `https://mail.company.local`. Sign in with the e-mail address and LAN password. Webmail shows new mail instantly and works much like Outlook.

### Folders

- **New folder:** click *+ New folder*. Hover over a folder and click **+** to make a subfolder inside it.
- **Moving mail:** drag messages onto a folder (select several first to move them together), or use *Move to…*.
- **Same folders everywhere:** folders are kept on the server, so a folder made in webmail appears in Outlook, Thunderbird and on phones at their next *Send/Receive*, and the other way round. Nothing has to be set up again on a new PC. If a folder does not appear in Outlook, right-click the account, choose *IMAP Folders…* and click *Query*.

### Rules ("Always move messages from this sender")

- **From a message:** open a message and click **Always move from sender…**. Choose a folder (or type a new one) and, if you like, move the mail from that sender already in the folder. New mail from them goes straight into that folder.
- **Your rules:** see and change all your rules under *Rules & out of office*. There you can sort by sender, subject, words, attachments and more, and use **Run now** to apply a rule to the mail already in your Inbox.
- **Server rules vs Outlook rules:** these rules run on the server, so they work everywhere: webmail, Outlook and phones, even when your PC is off. Rules you make inside Outlook's own *Rules* menu only run in that copy of Outlook while it is open. For rules that should always apply, make them in webmail.

### Deleting mail

Deleting mail from your mailbox does not delete it from the company archive. The archive keeps every message you send and receive for the retention period your company sets.
