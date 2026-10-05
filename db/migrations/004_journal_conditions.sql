-- =============================================================================
-- 004_journal_conditions.sql
-- Journaling of SELECTED mail: a journal rule may carry the same conditions
-- as a mail rule (subject, from, to, size, attachment, ...), evaluated in
-- addition to its direction and scope.
-- =============================================================================

ALTER TABLE journal_rules
  ADD COLUMN match_mode ENUM('all','any') NOT NULL DEFAULT 'all' AFTER include_internal,
  ADD COLUMN conditions JSON NULL AFTER match_mode,
  ADD COLUMN hit_count BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER is_enabled,
  ADD COLUMN last_hit_at DATETIME(3) NULL AFTER hit_count;
