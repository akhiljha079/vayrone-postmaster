-- =============================================================================
-- 002_message_header_cache.sql
-- Raw RFC 5322 header block of each message, cached in the DB so IMAP
-- header-only fetches (Outlook/Thunderbird initial sync, HEADER.FIELDS,
-- header SEARCH) never decompress the full message file.
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN header_raw MEDIUMBLOB NULL AFTER bodystructure_json;

-- Messages created by an IMAP APPEND (Outlook/Thunderbird saving Sent/Drafts).
ALTER TABLE mail_items
  MODIFY COLUMN origin ENUM('lan_smtp','fetch','webmail','internal','journal','restore','import','rule','imap_append') NOT NULL;
