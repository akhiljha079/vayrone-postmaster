-- =============================================================================
-- 010_archive_mailboxes.sql
-- The archive is browsed and exported as one folder per mailbox address, with
-- "Received" and "Sent" inside. Each link between an archived message and a
-- user now records the user's role and their address at the time, so the
-- folder keeps its name after the user account is renamed or deleted.
-- =============================================================================

ALTER TABLE archive_item_users
  ADD COLUMN role    ENUM('received','sent') NOT NULL DEFAULT 'received' AFTER user_id,
  ADD COLUMN address VARCHAR(254)            NULL AFTER role,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (archive_id, user_id, role),
  DROP KEY ix_aiu_user,
  ADD KEY ix_aiu_mailbox (user_id, role, archive_id);

-- Existing items: the address from the user account; "sent" when that user was the envelope sender.
UPDATE archive_item_users x JOIN users u ON u.id = x.user_id SET x.address = u.login;
UPDATE archive_item_users x JOIN archive_items a ON a.id = x.archive_id
   SET x.role = 'sent'
 WHERE a.direction IN ('out', 'internal') AND x.address IS NOT NULL AND LOWER(a.envelope_from) = LOWER(x.address);
