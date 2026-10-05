# Security and hardening

For client IT administrators and Vayrone technicians. What the product protects by itself, and what to configure at the site.

## Built in

| Area | Protection |
|------|------------|
| Program | One executable containing compiled V8 bytecode, not readable source. The licensing code is obfuscated before compilation. Release builds verify a signed list of program-file hashes at start and every day; a modified file switches the admin panel to read-only and raises an alert. |
| Updates | Only packages signed by Vayrone Infratech are installed. Every file hash is checked twice: on download and just before install. A database snapshot is taken first, and the update rolls back automatically on failure. |
| Licence | Signed licence (Ed25519) bound to the hardware; clock tampering is detected; mail keeps flowing in every licence state. |
| Stored secrets | Provider passwords, relay passwords, TOTP seeds and cloud credentials are encrypted with AES-256-GCM. The master key is in a root-only file (Linux) or protected by Windows DPAPI. These passwords can only be written through the API, never read back. |
| User passwords | scrypt hashes. Lockout after repeated failures on every protocol (web, IMAP, POP3, SMTP). Optional TOTP, which can be required for admins. |
| Web | HTTPS (TLS 1.2+), HSTS, strict Content-Security-Policy, `SameSite=Strict` session cookies, CSRF tokens, `no-store` on API answers, rate limits on sign-in. Request time limits stop stalled clients. Cookies and tokens never appear in logs. |
| Mail protocols | TLS 1.2+ on IMAPS/POP3S/SMTPS and STARTTLS. Sign-in is required to send. The From address is checked against the user's own addresses. Connections are capped per address (300) and in total (5000). |
| Email content in webmail | Shown in a sandboxed frame with scripts disabled; remote images are blocked until the user allows them. |
| Audit | Every admin action, including Vayrone Support's, is written to a hash-chained audit log, which is verified every night. |
| Services | Linux: user `vpm` under systemd sandboxing (read-only system, private /tmp, no new privileges, `CAP_NET_BIND_SERVICE` only). Windows: data and configuration folders restricted to Administrators and SYSTEM. The database listens on localhost only. |
| Start-up checks | Warns (and raises an alert) if the config file, master key or data folder can be read by other accounts, or if a service runs as root. |

## Configure at the site

1. **Network:** keep the server on the LAN. Do not forward mail or web ports from the internet. For mobile access, use the company VPN.
2. **Firewall:** allow the mail and web ports from the office subnets only. The installers open them for the domain/private profile (Windows) or in ufw/firewalld (Linux). Narrow them further if possible.
3. **Admin access:** Admin → Security:
   - limit the admin panel to the IT team's IP addresses;
   - require two-step verification for admins.
4. **Certificate:** if the company has an internal CA or a public certificate for the server name, install it in Admin → Network & TLS. Otherwise distribute the self-signed certificate to PCs ([mail-clients.md](mail-clients.md)).
5. **Plain-text sign-in:** to require TLS for IMAP/POP3/SMTP sign-in, set `"allowPlaintextAuth": false` in the config file and restart. After that, only the TLS ports or STARTTLS accept passwords.
6. **Backups:** keep at least one copy off the server (NAS, USB rotated off-site, or encrypted cloud). Store the cloud passphrase and the master key separately from the server.
7. **Operating system:** apply OS security updates monthly; keep automatic time sync on; protect the server with a UPS.
8. **Accounts:**
   - only the people who need it get *super admin*;
   - give auditors the *Auditor* role, not *Admin*;
   - disable users who leave the company (their mail is kept, and they no longer use a licence seat).
9. **Vayrone Support access:** leave it switched off (Admin → Security) unless support is working on the server.
10. **Monitoring:** set alert e-mails. Optionally connect Prometheus/Zabbix to `/metrics`, using a bearer token.

## Reporting a security problem

Write to security@vayrone.com with the version (shown under *About* in the page footer) and the steps to reproduce. Do not post details publicly.
