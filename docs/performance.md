# Performance and sizing

**Target (spec §8):** 500 LAN users and 1000 external provider mailboxes.

**Test:** `scripts/loadtest.sh`, which runs `worker/test/load.test.ts` with `VPM_LOAD=1`. Raw numbers are in [performance-results.json](performance-results.json).

## Test setup (pessimistic)

Everything ran in **one Node.js process** on a 2013 laptop (Intel i7-4770HQ, 4 cores / 8 threads, macOS, Node 20), sharing the machine with the test MySQL:

- the "provider" IMAP server holding the 1000 external mailboxes;
- the fetcher;
- 500 Outlook-like IMAP clients;
- 50 SMTP senders.

A real install is lighter on the server in four ways:

- core and worker run as separate processes;
- providers are remote;
- client programs run on employees' PCs;
- the database has its own memory.

Treat these numbers as a lower bound.

## Results (2026-10-06)

| Scenario | Result | Pass mark |
|----------|--------|-----------|
| Initial fetch: 1000 accounts × 3 messages over IMAP/STARTTLS, 50 parallel | 3000 messages in **28.8 s** (104 msg/s, 35 accounts/s), RSS 179 MB, no account errors | all fetched, no errors |
| IMAP IDLE watcher on every external account | 1000 watchers connected in **9.6 s**, RSS 311 MB | all connected |
| New provider mail → local mailbox (50 accounts at once) | p50 **0.79 s**, p95 **0.80 s**, max 0.80 s | p95 < 30 s |
| 500 mail clients connected and IDLE on INBOX | connected in **4.1 s**, RSS 298 MB | — |
| Internal delivery → IDLE push to the client (50 at once) | p50 **0.41 s**, p95 **0.41 s** | p95 < 5 s |
| SMTP submission: 2000 messages (1 local + 1 external recipient each), 50 parallel senders, authenticated, STARTTLS | **24.7 s** (81 msg/s), RSS 288 MB | all accepted |

**Notes on the latency numbers:**

- They include the test's own polling: it checks for the message every 100 ms.
- The 50 samples start together, which is why p50 ≈ p95.

## What changed to meet the target

**Problem, first full run:** new provider mail took p95 **34 s** to arrive with 1000 IDLE watchers. When all watchers connect, each one asks for a catch-up fetch. Those 1000 fetches queued ahead of real "new mail" signals.

**Fix in `worker/src/fetcher.ts`:**

- watchers start in batches of 25 every 100 ms;
- the catch-up is skipped when the account was fetched in the last 60 s;
- accounts with an `EXISTS` signal go into an **urgent** queue served before routine polls.

**Result:** p95 is **0.8 s**.

## Sizing guidance

| Users | External mailboxes | Server |
|-------|--------------------|--------|
| ≤ 50 | ≤ 100 | 4 cores, 8 GB RAM, SSD |
| ≤ 200 | ≤ 400 | 4–8 cores, 16 GB RAM, SSD |
| ≤ 500 | ≤ 1000 | 8 cores, 16–32 GB RAM, SSD; Linux recommended |

**Process memory** is about 300 MB at full scale for the mail services. MySQL/MariaDB should get 2–4 GB of buffer pool at 500 users. Full-text search and the archive grow with mail volume.

**Disk:**

- about 1 GB per user per year;
- attachments are stored once per message, not per recipient;
- backups go to a separate disk, NAS or cloud bucket.

**Provider limits matter more than the server.** The fetcher caps connections per provider host (default 8) so shared hosts such as Hostinger or GoDaddy do not block the company's IP. Raise the cap only for providers that allow it.

## Not covered here

- **Real Windows Server and Linux hardware:** to be repeated on the first pilot server with `VPM_LOAD_USERS` / `VPM_LOAD_ACCOUNTS` set to the site's size.
- **Large attachments (> 10 MB) and archive search at multi-year scale:** to be measured at a pilot.
- **Antivirus and Rspamd latency:** these add the scanner's own time per message (typically 10–100 ms for ClamAV).
