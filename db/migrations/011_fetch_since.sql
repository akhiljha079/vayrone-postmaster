-- =============================================================================
-- 011_fetch_since.sql
-- "Download mail received from <date>": per external mailbox, mail that arrived
-- at the provider before this date is never downloaded (e.g. when moving from
-- another mail server whose PCs already hold the old mail). Such messages are
-- remembered as skipped, and the leave-on-server policy never deletes them.
-- =============================================================================

ALTER TABLE external_accounts
  ADD COLUMN fetch_since DATETIME(3) NULL AFTER keep_days;

ALTER TABLE external_seen
  ADD COLUMN skipped TINYINT(1) NOT NULL DEFAULT 0 AFTER item_id;
