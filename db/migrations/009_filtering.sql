-- =============================================================================
-- 009_filtering.sql
-- Spam, antivirus and attachment filtering: quarantine for held messages and
-- sender allow/block lists (global or per user, fed by webmail Junk/Not junk).
-- =============================================================================

CREATE TABLE quarantine (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id    BIGINT UNSIGNED NOT NULL,            -- messages.id (refcount held while quarantined)
  direction     ENUM('in','internal','out') NOT NULL,
  kind          ENUM('virus','attachment','spam') NOT NULL,
  reason        VARCHAR(500)    NOT NULL,
  envelope_from VARCHAR(254)    NOT NULL,
  recipients    JSON            NOT NULL,            -- [{userId, folderId?}] for in/internal
  subject       VARCHAR(255)    NULL,
  size          INT UNSIGNED    NOT NULL,
  origin        VARCHAR(20)     NOT NULL,
  external_account_id BIGINT UNSIGNED NULL,
  created_at    DATETIME(3)     NOT NULL,
  released_at   DATETIME(3)     NULL,
  released_by   BIGINT UNSIGNED NULL,
  deleted_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_quar_open (deleted_at, released_at, created_at),
  KEY ix_quar_kind (kind, created_at),
  CONSTRAINT fk_quar_message FOREIGN KEY (message_id) REFERENCES messages (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sender_lists (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NULL,                  -- NULL = whole server
  pattern     VARCHAR(254)    NOT NULL,              -- address or @domain
  kind        ENUM('allow','block') NOT NULL,
  source      ENUM('admin','user','webmail') NOT NULL DEFAULT 'admin',
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sender_list (user_id, pattern),
  KEY ix_sender_pattern (pattern),
  CONSTRAINT fk_sender_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
