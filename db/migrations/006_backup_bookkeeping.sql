-- =============================================================================
-- 006_backup_bookkeeping.sql
-- Backup runs: directory name on the target, progress, and an 'expired'
-- state for runs removed by rotation (keep_full). Restore runs: result details.
-- =============================================================================

ALTER TABLE backup_runs
  ADD COLUMN dir_name VARCHAR(255) NULL AFTER manifest_path,
  ADD COLUMN progress TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER status,
  MODIFY COLUMN status ENUM('running','ok','failed','verifying','verified','corrupt','expired') NOT NULL;

ALTER TABLE restore_runs
  ADD COLUMN result JSON NULL AFTER items_restored,
  ADD COLUMN target_user_id BIGINT UNSIGNED NULL AFTER scope;
