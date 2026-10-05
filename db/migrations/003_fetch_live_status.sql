-- =============================================================================
-- 003_fetch_live_status.sql
-- Live status for external POP3/IMAP accounts (admin panel) and a dedicated
-- "mailbox full" state: fetched mail is never dropped — when the local mailbox
-- is over quota the fetcher stops and leaves the mail on the provider.
-- =============================================================================

ALTER TABLE external_accounts
  ADD COLUMN provider_preset VARCHAR(40) NULL AFTER label,
  ADD COLUMN remote_count INT UNSIGNED NULL AFTER fetched_total,
  ADD COLUMN remote_bytes BIGINT UNSIGNED NULL AFTER remote_count,
  ADD COLUMN idle_active TINYINT(1) NOT NULL DEFAULT 0 AFTER remote_bytes,
  MODIFY COLUMN status ENUM('idle','connecting','fetching','idling','backoff','auth_failed','error','disabled','quota_full') NOT NULL DEFAULT 'idle';

ALTER TABLE fetch_runs
  MODIFY COLUMN result ENUM('ok','partial','auth_failed','network','protocol','error','quota_full') NULL;
