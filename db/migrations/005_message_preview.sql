-- =============================================================================
-- 005_message_preview.sql
-- First characters of the message text, computed once at ingest, so the
-- webmail message list can show a preview line without decoding bodies.
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN preview VARCHAR(255) NULL AFTER hdr_from;
