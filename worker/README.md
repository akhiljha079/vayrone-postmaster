# /worker — background jobs

Phase 3: **outbound relay sender** ([src/sender.ts](src/sender.ts)).

- Claims due `outbound_queue` rows atomically (`UPDATE … ORDER BY … LIMIT`), so several workers never send the same message twice; stale claims are re-taken after 5 minutes.
- Resolves the relay per message: user route → domain route → domain smart host → default relay (or the employee's own provider account).
- Pooled nodemailer transports per relay, optional per-relay messages-per-minute limit.
- Per-recipient results: 2xx sent, 5xx failed, everything else retried after 1, 5, 15, 30 and 60 minutes, then hourly until the entry expires (3 days).
- Permanent failures and expiry generate an RFC 3464 bounce delivered to the sender's INBOX.
- Mail is never dropped: with no relay, or with a relay login failure, messages wait and a critical admin alert is raised.

Phase 4: **external POP3/IMAP fetcher** ([src/fetcher.ts](src/fetcher.ts), protocol logic in [core/src/fetch](../core/src/fetch)).

- Due accounts are claimed with a DB lease, so several workers never fetch the same account.
- Concurrency caps: 50 overall and 8 per provider host by default. Each account is isolated, so one failing provider never blocks the others.
- Network errors back off 30 s → 1 → 2 → 4 → 8 → 15 min. A wrong provider password pauses the account (status `auth_failed`, critical alert) until an admin edits it. A full local mailbox (`quota_full`) waits 15 minutes and leaves the mail on the provider.
- IMAP accounts with "instant push" get a persistent IDLE watcher. New provider mail triggers a fetch immediately, and polling every 5 minutes stays on as a safety net.
- Leave-on-server: delete after download, keep, or keep for N days. Remote copies are deleted only after the local commit.
- Mail this process delivers is announced to core over loopback IPC, so Outlook IDLE sessions get it at once.

Phase 7: **job runner and scheduler** ([src/jobs.ts](src/jobs.ts), [src/scheduler.ts](src/scheduler.ts)).

- The `jobs` table is the queue. Claims are atomic, a job whose worker died is retried when its lock expires, and failures retry with backoff. Restores are never retried automatically.
- Backup schedules (cron, from the DB, re-read every minute) and nightly maintenance: retention, garbage collection, housekeeping, backup verification, freshness alert. Each time slot is enqueued with a dedupe key, so it runs once even with several workers.
- Background full-text indexing of new messages every 5 s.

```sh
npm run dev     # needs VPM_CONFIG
npm test        # uses a fake provider SMTP server
```
