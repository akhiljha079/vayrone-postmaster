-- =============================================================================
-- 008_monitoring.sql
-- Monitoring (Phase 10): alert e-mails are queued as 'system' messages, and an
-- alert is e-mailed once per occurrence burst (notified_at).
-- =============================================================================

ALTER TABLE outbound_queue
  MODIFY COLUMN source ENUM('submission','webmail','forward','redirect','autoreply','journal','bounce','list','rule','system') NOT NULL;

ALTER TABLE admin_alerts
  ADD COLUMN notified_at DATETIME(3) NULL AFTER last_at;

-- Cloud backup targets (S3, FTP): what was uploaded, for the nightly remote check.
ALTER TABLE backup_runs
  ADD COLUMN remote_objects INT UNSIGNED NULL AFTER bytes,
  ADD COLUMN remote_bytes BIGINT UNSIGNED NULL AFTER remote_objects;
