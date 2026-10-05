-- =============================================================================
-- Vayrone PostMaster — 001_initial_schema.sql
-- Target: MariaDB 10.11+ / 11.4 LTS, MySQL 8.4 LTS. InnoDB, utf8mb4.
--
-- Conventions
--   * All timestamps are UTC, DATETIME(3). The app sets time_zone = '+00:00'.
--   * Email local parts and domain names are stored lower-cased (IDN as A-label).
--   * Secrets (external passwords, TOTP seeds, private keys) are stored only as
--     AES-256-GCM envelopes: VARBINARY = [key_version:1][iv:12][tag:16][ciphertext].
--   * Free-form structured data uses JSON columns validated by the app (zod).
--   * IMAP UIDVALIDITY / UID / MODSEQ and POP3 UIDL values are assigned once and
--     NEVER regenerated (see docs/ARCHITECTURE.md §7). Backup/restore copies them
--     verbatim.
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

-- -----------------------------------------------------------------------------
-- 0. Migration bookkeeping and site configuration
-- -----------------------------------------------------------------------------

CREATE TABLE schema_migrations (
  version      INT UNSIGNED     NOT NULL,
  name         VARCHAR(200)     NOT NULL,
  checksum     CHAR(64)         NOT NULL,                -- SHA-256 of the .sql file
  app_version  VARCHAR(32)      NOT NULL,
  applied_at   DATETIME(3)      NOT NULL,
  duration_ms  INT UNSIGNED     NOT NULL DEFAULT 0,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  namespace    VARCHAR(64)      NOT NULL,                -- 'network','storage','security','spam',...
  name         VARCHAR(128)     NOT NULL,
  value        JSON             NOT NULL,
  updated_at   DATETIME(3)      NOT NULL,
  updated_by   BIGINT UNSIGNED  NULL,
  PRIMARY KEY (namespace, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single row (id = 1). Client company details from the setup wizard.
CREATE TABLE company_profile (
  id              TINYINT UNSIGNED NOT NULL,
  company_name    VARCHAR(200)     NOT NULL,
  address         TEXT             NULL,
  gstin           VARCHAR(15)      NULL,
  contact_person  VARCHAR(120)     NULL,
  phone           VARCHAR(32)      NULL,
  email           VARCHAR(254)     NULL,
  logo_path       VARCHAR(255)     NULL,                 -- relative to data path
  updated_at      DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_company_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Setup wizard progress (single row). Wizard is locked once completed_at is set.
CREATE TABLE setup_state (
  id              TINYINT UNSIGNED NOT NULL,
  current_step    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  completed_steps JSON             NOT NULL,
  completed_at    DATETIME(3)      NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_setup_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cluster-safe named mutex / leader lease (scheduler singletons, migrations).
CREATE TABLE app_locks (
  name         VARCHAR(100)     NOT NULL,
  owner        VARCHAR(100)     NOT NULL,                -- "<host>:<pid>:<role>"
  acquired_at  DATETIME(3)      NOT NULL,
  expires_at   DATETIME(3)      NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 1. Domains, users, addresses, aliases, groups, lists
-- -----------------------------------------------------------------------------

CREATE TABLE relay_accounts (
  id               BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  name             VARCHAR(100)     NOT NULL,
  host             VARCHAR(253)     NOT NULL,
  port             SMALLINT UNSIGNED NOT NULL,
  security         ENUM('none','starttls','tls') NOT NULL DEFAULT 'starttls',
  auth_user        VARCHAR(254)     NULL,
  auth_secret      VARBINARY(1024)  NULL,                -- AES-GCM envelope, write-only in API
  envelope_from    ENUM('relay_account','original_sender') NOT NULL DEFAULT 'relay_account',
  set_sender_header TINYINT(1)      NOT NULL DEFAULT 1,  -- add Sender: <relay account>
  max_msgs_per_min INT UNSIGNED     NULL,
  max_connections  TINYINT UNSIGNED NOT NULL DEFAULT 2,
  tls_verify       TINYINT(1)       NOT NULL DEFAULT 1,
  is_default       TINYINT(1)       NOT NULL DEFAULT 0,
  is_enabled       TINYINT(1)       NOT NULL DEFAULT 1,
  last_test_at     DATETIME(3)      NULL,
  last_test_result VARCHAR(500)     NULL,
  created_at       DATETIME(3)      NOT NULL,
  updated_at       DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_relay_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE domains (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name                      VARCHAR(253)    NOT NULL,     -- lower-case A-label
  is_enabled                TINYINT(1)      NOT NULL DEFAULT 1,
  -- What happens to mail for <unknown>@this-domain submitted on the LAN:
  --   reject  : 550 at RCPT time
  --   catchall: deliver to catchall_user_id
  --   relay   : send out through the relay (mailbox lives only at the provider)
  unknown_recipient_action  ENUM('reject','catchall','relay') NOT NULL DEFAULT 'relay',
  catchall_user_id          BIGINT UNSIGNED NULL,
  smart_host_relay_id       BIGINT UNSIGNED NULL,         -- per-domain smart host override
  default_quota_bytes       BIGINT UNSIGNED NOT NULL DEFAULT 5368709120,
  created_at                DATETIME(3)     NOT NULL,
  updated_at                DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_domain_name (name),
  CONSTRAINT fk_domain_smarthost FOREIGN KEY (smart_host_relay_id) REFERENCES relay_accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  login                VARCHAR(254)    NOT NULL,          -- usually the primary email
  display_name         VARCHAR(200)    NOT NULL,
  role                 ENUM('super_admin','admin','user','auditor','vayrone_support') NOT NULL DEFAULT 'user',
  domain_id            BIGINT UNSIGNED NULL,              -- NULL for non-mailbox staff accounts
  has_mailbox          TINYINT(1)      NOT NULL DEFAULT 1,
  password_hash        VARCHAR(255)    NOT NULL,          -- scrypt$N$r$p$salt$hash (LAN password)
  password_changed_at  DATETIME(3)     NOT NULL,
  must_change_password TINYINT(1)      NOT NULL DEFAULT 0,
  is_enabled           TINYINT(1)      NOT NULL DEFAULT 1,
  -- Counts against the licence only when is_enabled = 1 AND has_mailbox = 1
  -- AND role <> 'vayrone_support'.
  allow_imap           TINYINT(1)      NOT NULL DEFAULT 1,
  allow_pop3           TINYINT(1)      NOT NULL DEFAULT 1,
  allow_smtp           TINYINT(1)      NOT NULL DEFAULT 1,
  allow_webmail        TINYINT(1)      NOT NULL DEFAULT 1,
  quota_bytes          BIGINT UNSIGNED NULL,              -- NULL = domain default
  used_bytes           BIGINT UNSIGNED NOT NULL DEFAULT 0,
  -- Per-user UIDVALIDITY source: each new folder takes the current value and
  -- increments it. Seeded with UNIX_TIMESTAMP() at user creation so values are
  -- unique even across user delete/recreate. Never decreases.
  next_uidvalidity     INT UNSIGNED    NOT NULL,
  totp_secret          VARBINARY(256)  NULL,              -- AES-GCM envelope
  totp_enabled         TINYINT(1)      NOT NULL DEFAULT 0,
  failed_logins        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until         DATETIME(3)     NULL,
  last_login_at        DATETIME(3)     NULL,
  last_login_ip        VARCHAR(45)     NULL,
  locale               VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  timezone             VARCHAR(64)     NOT NULL DEFAULT 'Asia/Kolkata',
  created_at           DATETIME(3)     NOT NULL,
  updated_at           DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_login (login),
  KEY ix_user_domain (domain_id),
  KEY ix_user_licensed (is_enabled, has_mailbox, role),
  CONSTRAINT fk_user_domain FOREIGN KEY (domain_id) REFERENCES domains (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE domains
  ADD CONSTRAINT fk_domain_catchall FOREIGN KEY (catchall_user_id) REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE user_recovery_codes (
  user_id      BIGINT UNSIGNED NOT NULL,
  code_hash    CHAR(64)        NOT NULL,                  -- SHA-256
  used_at      DATETIME(3)     NULL,
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT fk_recovery_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE distribution_lists (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(200)    NOT NULL,
  sender_policy  ENUM('anyone','domain','members','listed') NOT NULL DEFAULT 'domain',
  allowed_senders JSON           NULL,                    -- when sender_policy = 'listed'
  expand_external TINYINT(1)     NOT NULL DEFAULT 1,      -- relay to external members
  created_at     DATETIME(3)     NOT NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Single address namespace: every routable local address (mailbox, alias, list)
-- has exactly one row, so the DB enforces global uniqueness per domain.
CREATE TABLE addresses (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  domain_id   BIGINT UNSIGNED NOT NULL,
  local_part  VARCHAR(64)     NOT NULL,
  kind        ENUM('mailbox','alias','list') NOT NULL,
  user_id     BIGINT UNSIGNED NULL,                       -- kind = mailbox
  list_id     BIGINT UNSIGNED NULL,                       -- kind = list
  is_primary  TINYINT(1)      NOT NULL DEFAULT 0,         -- user's primary From
  is_enabled  TINYINT(1)      NOT NULL DEFAULT 1,
  created_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_address (domain_id, local_part),
  KEY ix_address_user (user_id),
  KEY ix_address_list (list_id),
  CONSTRAINT fk_address_domain FOREIGN KEY (domain_id) REFERENCES domains (id) ON DELETE CASCADE,
  CONSTRAINT fk_address_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_address_list   FOREIGN KEY (list_id)   REFERENCES distribution_lists (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alias expansion targets (local user and/or external address).
CREATE TABLE alias_targets (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  address_id       BIGINT UNSIGNED NOT NULL,
  target_user_id   BIGINT UNSIGNED NULL,
  target_external  VARCHAR(254)    NULL,
  PRIMARY KEY (id),
  KEY ix_alias_addr (address_id),
  CONSTRAINT fk_alias_addr FOREIGN KEY (address_id) REFERENCES addresses (id) ON DELETE CASCADE,
  CONSTRAINT fk_alias_user FOREIGN KEY (target_user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE list_members (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  list_id           BIGINT UNSIGNED NOT NULL,
  user_id           BIGINT UNSIGNED NULL,
  external_address  VARCHAR(254)    NULL,
  PRIMARY KEY (id),
  KEY ix_listmember_list (list_id),
  CONSTRAINT fk_listmember_list FOREIGN KEY (list_id) REFERENCES distribution_lists (id) ON DELETE CASCADE,
  CONSTRAINT fk_listmember_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin groups: used as scopes for rules, journaling, retention and policies.
CREATE TABLE user_groups (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(100)    NOT NULL,
  description  VARCHAR(500)    NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_group_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_group_members (
  group_id  BIGINT UNSIGNED NOT NULL,
  user_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (group_id, user_id),
  KEY ix_ugm_user (user_id),
  CONSTRAINT fk_ugm_group FOREIGN KEY (group_id) REFERENCES user_groups (id) ON DELETE CASCADE,
  CONSTRAINT fk_ugm_user  FOREIGN KEY (user_id)  REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. Sessions, access control
-- -----------------------------------------------------------------------------

CREATE TABLE sessions (
  id            CHAR(64)        NOT NULL,                 -- SHA-256 of the opaque cookie token
  user_id       BIGINT UNSIGNED NOT NULL,
  kind          ENUM('web','imap','pop3','smtp') NOT NULL DEFAULT 'web',
  ui_mode       ENUM('mail','admin') NOT NULL DEFAULT 'mail',
  mfa_passed    TINYINT(1)      NOT NULL DEFAULT 0,
  ip            VARCHAR(45)     NOT NULL,
  user_agent    VARCHAR(500)    NULL,
  created_at    DATETIME(3)     NOT NULL,
  last_seen_at  DATETIME(3)     NOT NULL,
  expires_at    DATETIME(3)     NOT NULL,
  revoked_at    DATETIME(3)     NULL,
  revoked_by    BIGINT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_session_user (user_id, revoked_at),
  KEY ix_session_expiry (expires_at),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ip_allowlist (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cidr         VARCHAR(49)     NOT NULL,                  -- IPv4/IPv6 CIDR
  applies_to   SET('web','admin','imap','pop3','smtp') NOT NULL DEFAULT 'web,admin,imap,pop3,smtp',
  description  VARCHAR(200)    NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at           DATETIME(3)     NOT NULL,
  login        VARCHAR(254)    NOT NULL,
  user_id      BIGINT UNSIGNED NULL,
  protocol     ENUM('web','imap','pop3','smtp') NOT NULL,
  ip           VARCHAR(45)     NOT NULL,
  success      TINYINT(1)      NOT NULL,
  reason       VARCHAR(64)     NULL,                      -- bad_password, locked, ip_denied, mfa_failed...
  PRIMARY KEY (id),
  KEY ix_login_at (at),
  KEY ix_login_ip (ip, at),
  KEY ix_login_user (user_id, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. Message store (metadata; bodies are compressed EML files on disk)
-- -----------------------------------------------------------------------------

-- Single-instance store. One row per unique raw message (by SHA-256 of the raw
-- bytes). Shared by every mailbox copy, archive item and outbound queue entry.
CREATE TABLE messages (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sha256            BINARY(32)      NOT NULL,             -- hash of raw RFC 5322 bytes
  content_hash      BINARY(32)      NOT NULL,             -- hash of normalised content (dedup)
  storage_path      VARCHAR(255)    NOT NULL,             -- relative: store/ab/cd/<hex>.eml.zst
  codec             TINYINT UNSIGNED NOT NULL DEFAULT 1,  -- 0 raw, 1 gzip, 2 zstd
  size_raw          BIGINT UNSIGNED NOT NULL,             -- RFC822.SIZE
  size_stored       BIGINT UNSIGNED NOT NULL,
  refcount          INT UNSIGNED    NOT NULL DEFAULT 0,   -- GC when 0 and older than grace period
  hdr_message_id    VARCHAR(255)    NULL,                 -- truncated; full value in envelope_json
  hdr_message_id_hash BINARY(32)    NULL,
  hdr_date          DATETIME(3)     NULL,
  hdr_subject       VARCHAR(998)    NULL,
  hdr_from          VARCHAR(512)    NULL,
  has_attachments   TINYINT(1)      NOT NULL DEFAULT 0,
  -- Cached IMAP ENVELOPE and BODYSTRUCTURE so FETCH never re-parses the file.
  envelope_json     JSON            NOT NULL,
  bodystructure_json JSON           NOT NULL,
  created_at        DATETIME(3)     NOT NULL,
  verified_at       DATETIME(3)     NULL,                 -- last integrity check
  PRIMARY KEY (id),
  UNIQUE KEY uq_message_sha (sha256),
  KEY ix_message_msgid (hdr_message_id_hash),
  KEY ix_message_gc (refcount, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Full-text index (MySQL/MariaDB InnoDB FULLTEXT). Body text is extracted
-- plain text, capped at 1 MiB per message.
CREATE TABLE message_search (
  message_id   BIGINT UNSIGNED NOT NULL,
  subject      VARCHAR(998)    NOT NULL DEFAULT '',
  addresses    TEXT            NOT NULL,                  -- from/to/cc/bcc names + addresses
  attachment_names TEXT        NOT NULL,
  body_text    MEDIUMTEXT      NOT NULL,
  PRIMARY KEY (message_id),
  FULLTEXT KEY ft_message (subject, addresses, attachment_names, body_text),
  CONSTRAINT fk_search_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE folders (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  parent_id       BIGINT UNSIGNED NULL,
  path            VARCHAR(1000)   NOT NULL,                -- full IMAP name, '/' delimiter, UTF-8
  path_hash       BINARY(32)      NOT NULL,                -- SHA-256(lower(path)) for uniqueness
  special_use     ENUM('inbox','sent','drafts','trash','junk','archive','outbox') NULL,
  uidvalidity     INT UNSIGNED    NOT NULL,                -- from users.next_uidvalidity; immutable
  uidnext         INT UNSIGNED    NOT NULL DEFAULT 1,      -- never decreases
  highest_modseq  BIGINT UNSIGNED NOT NULL DEFAULT 1,      -- never decreases
  message_count   INT UNSIGNED    NOT NULL DEFAULT 0,      -- denormalised for STATUS
  unseen_count    INT UNSIGNED    NOT NULL DEFAULT 0,
  total_bytes     BIGINT UNSIGNED NOT NULL DEFAULT 0,
  subscribed      TINYINT(1)      NOT NULL DEFAULT 1,
  retention_days  INT UNSIGNED    NULL,                    -- e.g. Trash auto-purge
  created_at      DATETIME(3)     NOT NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_folder_path (user_id, path_hash),
  UNIQUE KEY uq_folder_uidvalidity (user_id, uidvalidity),
  KEY ix_folder_parent (parent_id),
  -- No self-FK on parent_id: InnoDB cascades through self-references poorly
  -- (depth limit, row order). The app maintains the hierarchy.
  CONSTRAINT fk_folder_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE
)ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per message per folder. (folder_id, uid) is the IMAP identity.
CREATE TABLE mail_items (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  folder_id      BIGINT UNSIGNED NOT NULL,
  uid            INT UNSIGNED    NOT NULL,                 -- allocated from folders.uidnext
  modseq         BIGINT UNSIGNED NOT NULL,                 -- CONDSTORE
  message_id     BIGINT UNSIGNED NOT NULL,
  -- Stable POP3 UIDL, assigned once at insert ("<uidvalidity>.<uid>" of the
  -- folder it was first delivered to) and carried verbatim through moves of the
  -- same item, backup and restore.
  pop3_uidl      VARCHAR(70)     NOT NULL,
  flags          SMALLINT UNSIGNED NOT NULL DEFAULT 0,     -- bit0 \Seen 1 \Answered 2 \Flagged 3 \Deleted 4 \Draft 5 $Forwarded 6 $Junk 7 $NotJunk
  internal_date  DATETIME(3)     NOT NULL,                 -- IMAP INTERNALDATE
  size           BIGINT UNSIGNED NOT NULL,
  origin         ENUM('lan_smtp','fetch','webmail','internal','journal','restore','import','rule') NOT NULL,
  external_account_id BIGINT UNSIGNED NULL,                -- when origin = fetch
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_item_uid (folder_id, uid),
  UNIQUE KEY uq_item_uidl (user_id, pop3_uidl),
  KEY ix_item_modseq (folder_id, modseq),
  KEY ix_item_message (message_id),
  KEY ix_item_user_date (user_id, internal_date),
  CONSTRAINT fk_item_user    FOREIGN KEY (user_id)    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_item_folder  FOREIGN KEY (folder_id)  REFERENCES folders (id) ON DELETE CASCADE,
  CONSTRAINT fk_item_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_item_keywords (
  item_id   BIGINT UNSIGNED NOT NULL,
  keyword   VARCHAR(100)    NOT NULL,                      -- IMAP custom keyword (atom)
  PRIMARY KEY (item_id, keyword),
  CONSTRAINT fk_keyword_item FOREIGN KEY (item_id) REFERENCES mail_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Expunged UIDs with their modseq, for QRESYNC/VANISHED and offline-client sync.
CREATE TABLE folder_expunges (
  folder_id  BIGINT UNSIGNED NOT NULL,
  uid        INT UNSIGNED    NOT NULL,
  modseq     BIGINT UNSIGNED NOT NULL,
  at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (folder_id, uid),
  KEY ix_expunge_modseq (folder_id, modseq),
  CONSTRAINT fk_expunge_folder FOREIGN KEY (folder_id) REFERENCES folders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Duplicate-prevention ledger, per mailbox. key_hash = SHA-256(kind || value).
-- A hit within settings.dedup.window_hours is a duplicate; older rows are
-- refreshed in place and purged by a nightly job.
CREATE TABLE dedup_ledger (
  user_id       BIGINT UNSIGNED NOT NULL,
  key_kind      ENUM('message_id','content') NOT NULL,
  key_hash      BINARY(32)      NOT NULL,
  first_seen_at DATETIME(3)     NOT NULL,
  last_seen_at  DATETIME(3)     NOT NULL,
  hit_count     INT UNSIGNED    NOT NULL DEFAULT 1,
  item_id       BIGINT UNSIGNED NULL,
  PRIMARY KEY (user_id, key_kind, key_hash),
  KEY ix_dedup_age (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 4. External accounts (POP3/IMAP fetch)
-- -----------------------------------------------------------------------------

CREATE TABLE external_accounts (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id            BIGINT UNSIGNED NOT NULL,
  label              VARCHAR(100)    NULL,
  protocol           ENUM('pop3','imap') NOT NULL,
  host               VARCHAR(253)    NOT NULL,
  port               SMALLINT UNSIGNED NOT NULL,
  security           ENUM('none','starttls','tls') NOT NULL DEFAULT 'tls',
  tls_verify         TINYINT(1)      NOT NULL DEFAULT 1,
  username           VARCHAR(254)    NOT NULL,
  secret             VARBINARY(1024) NOT NULL,             -- AES-GCM envelope, write-only in API
  remote_folders     JSON            NULL,                 -- IMAP: ["INBOX"] by default
  target_folder_id   BIGINT UNSIGNED NULL,                 -- NULL = INBOX
  interval_sec       INT UNSIGNED    NOT NULL DEFAULT 30,
  use_idle           TINYINT(1)      NOT NULL DEFAULT 1,   -- IMAP IDLE when the server supports it
  leave_policy       ENUM('delete','keep','keep_days') NOT NULL DEFAULT 'keep_days',
  keep_days          SMALLINT UNSIGNED NOT NULL DEFAULT 14,
  can_send_as        TINYINT(1)      NOT NULL DEFAULT 0,   -- may be used as per-user relay
  smtp_host          VARCHAR(253)    NULL,
  smtp_port          SMALLINT UNSIGNED NULL,
  smtp_security      ENUM('none','starttls','tls') NULL,
  is_enabled         TINYINT(1)      NOT NULL DEFAULT 1,
  status             ENUM('idle','connecting','fetching','idling','backoff','auth_failed','error','disabled') NOT NULL DEFAULT 'idle',
  last_error         VARCHAR(1000)   NULL,
  last_success_at    DATETIME(3)     NULL,
  last_attempt_at    DATETIME(3)     NULL,
  next_run_at        DATETIME(3)     NULL,
  consecutive_fails  INT UNSIGNED    NOT NULL DEFAULT 0,
  fetched_total      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at         DATETIME(3)     NOT NULL,
  updated_at         DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_ext_user (user_id),
  KEY ix_ext_schedule (is_enabled, next_run_at),
  CONSTRAINT fk_ext_user   FOREIGN KEY (user_id)          REFERENCES users (id)   ON DELETE CASCADE,
  CONSTRAINT fk_ext_folder FOREIGN KEY (target_folder_id) REFERENCES folders (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- IMAP source sync cursor per remote folder.
CREATE TABLE external_imap_state (
  account_id      BIGINT UNSIGNED NOT NULL,
  remote_folder   VARCHAR(255)    NOT NULL,
  uidvalidity     INT UNSIGNED    NOT NULL,
  last_uid        INT UNSIGNED    NOT NULL DEFAULT 0,
  highest_modseq  BIGINT UNSIGNED NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (account_id, remote_folder),
  CONSTRAINT fk_imapstate_acct FOREIGN KEY (account_id) REFERENCES external_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every remote message already downloaded. remote_key is
--   POP3: "pop3:<UIDL>"   IMAP: "imap:<folder>:<uidvalidity>:<uid>"
-- Used to avoid re-downloads and to implement leave-on-server for N days.
CREATE TABLE external_seen (
  account_id         BIGINT UNSIGNED NOT NULL,
  remote_key_hash    BINARY(32)      NOT NULL,
  remote_key         VARCHAR(600)    NOT NULL,
  first_seen_at      DATETIME(3)     NOT NULL,
  remote_deleted_at  DATETIME(3)     NULL,
  item_id            BIGINT UNSIGNED NULL,
  PRIMARY KEY (account_id, remote_key_hash),
  KEY ix_seen_cleanup (account_id, remote_deleted_at, first_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fetch_runs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id    BIGINT UNSIGNED NOT NULL,
  started_at    DATETIME(3)     NOT NULL,
  finished_at   DATETIME(3)     NULL,
  trigger_kind  ENUM('schedule','idle','manual','test') NOT NULL,
  fetched       INT UNSIGNED    NOT NULL DEFAULT 0,
  duplicates    INT UNSIGNED    NOT NULL DEFAULT 0,
  deleted_remote INT UNSIGNED   NOT NULL DEFAULT 0,
  bytes         BIGINT UNSIGNED NOT NULL DEFAULT 0,
  result        ENUM('ok','partial','auth_failed','network','protocol','error') NULL,
  error         VARCHAR(1000)   NULL,
  PRIMARY KEY (id),
  KEY ix_fetchrun_acct (account_id, started_at),
  CONSTRAINT fk_fetchrun_acct FOREIGN KEY (account_id) REFERENCES external_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 5. Outbound relay routing and queue
-- -----------------------------------------------------------------------------

-- Overrides of the default relay. Most specific wins: user > domain > default.
CREATE TABLE relay_routes (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope                 ENUM('domain','user') NOT NULL,
  domain_id             BIGINT UNSIGNED NULL,
  user_id               BIGINT UNSIGNED NULL,
  relay_account_id      BIGINT UNSIGNED NULL,
  via_external_account_id BIGINT UNSIGNED NULL,            -- send with the user's own provider creds
  is_enabled            TINYINT(1)      NOT NULL DEFAULT 1,
  created_at            DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_route_domain (scope, domain_id),
  UNIQUE KEY uq_route_user (scope, user_id),
  CONSTRAINT fk_route_domain FOREIGN KEY (domain_id) REFERENCES domains (id) ON DELETE CASCADE,
  CONSTRAINT fk_route_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_route_relay  FOREIGN KEY (relay_account_id) REFERENCES relay_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_route_ext    FOREIGN KEY (via_external_account_id) REFERENCES external_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outbound_queue (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id         BIGINT UNSIGNED NOT NULL,
  envelope_from      VARCHAR(254)    NOT NULL,             -- '' for bounces
  sender_user_id     BIGINT UNSIGNED NULL,
  source             ENUM('submission','webmail','forward','redirect','autoreply','journal','bounce','list','rule') NOT NULL,
  relay_account_id   BIGINT UNSIGNED NULL,                 -- resolved at enqueue
  via_external_account_id BIGINT UNSIGNED NULL,
  status             ENUM('queued','sending','deferred','held','sent','partial','failed') NOT NULL DEFAULT 'queued',
  priority           TINYINT         NOT NULL DEFAULT 0,
  attempts           SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at    DATETIME(3)     NOT NULL,
  expires_at         DATETIME(3)     NOT NULL,             -- give up + bounce after this
  hold_reason        VARCHAR(200)    NULL,
  locked_by          VARCHAR(100)    NULL,
  locked_until       DATETIME(3)     NULL,
  last_error         VARCHAR(1000)   NULL,
  created_at         DATETIME(3)     NOT NULL,
  updated_at         DATETIME(3)     NOT NULL,
  completed_at       DATETIME(3)     NULL,
  PRIMARY KEY (id),
  KEY ix_outq_due (status, next_attempt_at),
  KEY ix_outq_sender (sender_user_id, created_at),
  CONSTRAINT fk_outq_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT,
  CONSTRAINT fk_outq_relay   FOREIGN KEY (relay_account_id) REFERENCES relay_accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE outbound_recipients (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue_id       BIGINT UNSIGNED NOT NULL,
  rcpt           VARCHAR(254)    NOT NULL,
  status         ENUM('pending','sent','deferred','failed') NOT NULL DEFAULT 'pending',
  attempts       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  smtp_code      SMALLINT UNSIGNED NULL,
  smtp_response  VARCHAR(1000)   NULL,
  updated_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_outrcpt_queue (queue_id, status),
  CONSTRAINT fk_outrcpt_queue FOREIGN KEY (queue_id) REFERENCES outbound_queue (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 6. Generic DB-backed job queue (no Redis required)
-- -----------------------------------------------------------------------------

CREATE TABLE jobs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  queue         VARCHAR(50)     NOT NULL,                  -- 'default','index','backup','archive',...
  type          VARCHAR(100)    NOT NULL,
  payload       JSON            NOT NULL,
  dedupe_key    VARCHAR(200)    NULL,                      -- unique while pending
  status        ENUM('pending','running','done','failed','cancelled') NOT NULL DEFAULT 'pending',
  priority      SMALLINT        NOT NULL DEFAULT 0,
  run_at        DATETIME(3)     NOT NULL,
  attempts      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts  SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  locked_by     VARCHAR(100)    NULL,
  locked_until  DATETIME(3)     NULL,
  progress      TINYINT UNSIGNED NULL,
  last_error    TEXT            NULL,
  result        JSON            NULL,
  created_at    DATETIME(3)     NOT NULL,
  updated_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_job_dedupe (dedupe_key),
  KEY ix_job_due (queue, status, run_at, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE scheduled_tasks (
  name          VARCHAR(100)    NOT NULL,                  -- 'dedup.purge','archive.retention',...
  cron          VARCHAR(100)    NOT NULL,
  is_enabled    TINYINT(1)      NOT NULL DEFAULT 1,
  last_run_at   DATETIME(3)     NULL,
  next_run_at   DATETIME(3)     NULL,
  last_status   VARCHAR(20)     NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 7. Rules, forwarding, auto-reply, journaling
-- -----------------------------------------------------------------------------

CREATE TABLE mail_rules (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope           ENUM('global','user') NOT NULL,
  user_id         BIGINT UNSIGNED NULL,
  name            VARCHAR(200)    NOT NULL,
  position        INT             NOT NULL,                -- drag-and-drop ordering (ascending)
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  stage           ENUM('inbound','outbound','both') NOT NULL DEFAULT 'inbound',
  match_mode      ENUM('all','any') NOT NULL DEFAULT 'all',
  -- [{field:'from'|'to'|'cc'|'subject'|'body'|'header'|'size'|'has_attachment'|
  --   'attachment_ext'|'direction'|'time', op:'contains'|'equals'|'regex'|'gt'|..., value, header?}]
  conditions      JSON            NOT NULL,
  -- [{type:'move'|'copy'|'forward'|'redirect'|'auto_reply'|'reject'|'discard'|
  --   'flag'|'mark_read'|'add_header'|'stop', ...params}]
  actions         JSON            NOT NULL,
  stop_processing TINYINT(1)      NOT NULL DEFAULT 0,
  hit_count       BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_hit_at     DATETIME(3)     NULL,
  created_by      BIGINT UNSIGNED NULL,
  created_at      DATETIME(3)     NOT NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_rule_order (scope, user_id, position),
  CONSTRAINT fk_rule_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE forwardings (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          BIGINT UNSIGNED NOT NULL,
  target_address   VARCHAR(254)    NOT NULL,
  keep_local_copy  TINYINT(1)      NOT NULL DEFAULT 1,
  is_enabled       TINYINT(1)      NOT NULL DEFAULT 1,
  created_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_forward (user_id, target_address),
  CONSTRAINT fk_forward_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE autoreplies (
  user_id         BIGINT UNSIGNED NOT NULL,
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 0,
  subject         VARCHAR(500)    NOT NULL,
  body_text       TEXT            NOT NULL,
  body_html       MEDIUMTEXT      NULL,
  starts_at       DATETIME(3)     NULL,
  ends_at         DATETIME(3)     NULL,
  internal_only   TINYINT(1)      NOT NULL DEFAULT 0,
  once_per_days   SMALLINT UNSIGNED NOT NULL DEFAULT 4,    -- RFC 3834 suppression window
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_autoreply_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE autoreply_log (
  user_id      BIGINT UNSIGNED NOT NULL,
  sender_hash  BINARY(32)      NOT NULL,
  sent_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (user_id, sender_hash),
  CONSTRAINT fk_arlog_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- BCC/journal copies of ALL or SELECTED inbound/outbound mail.
CREATE TABLE journal_rules (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name              VARCHAR(200)    NOT NULL,
  direction         ENUM('in','out','both') NOT NULL DEFAULT 'both',
  scope             ENUM('all','domain','group','user') NOT NULL DEFAULT 'all',
  scope_id          BIGINT UNSIGNED NULL,
  include_internal  TINYINT(1)      NOT NULL DEFAULT 1,
  target_address    VARCHAR(254)    NOT NULL,
  is_enabled        TINYINT(1)      NOT NULL DEFAULT 1,
  created_at        DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 8. Compliance archive and retention
-- -----------------------------------------------------------------------------

CREATE TABLE archive_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id       BIGINT UNSIGNED NOT NULL,               -- holds a messages.refcount reference
  direction        ENUM('in','out','internal') NOT NULL,
  envelope_from    VARCHAR(254)    NOT NULL,
  envelope_rcpts   JSON            NOT NULL,
  subject          VARCHAR(998)    NULL,
  hdr_date         DATETIME(3)     NULL,
  size             BIGINT UNSIGNED NOT NULL,
  archived_at      DATETIME(3)     NOT NULL,
  retention_until  DATETIME(3)     NULL,                   -- NULL = keep forever
  legal_hold       TINYINT(1)      NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_archive_date (archived_at),
  KEY ix_archive_retention (legal_hold, retention_until),
  CONSTRAINT fk_archive_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which local users an archived message belongs to (for per-user search/restore).
CREATE TABLE archive_item_users (
  archive_id  BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (archive_id, user_id),
  KEY ix_aiu_user (user_id, archive_id),
  CONSTRAINT fk_aiu_archive FOREIGN KEY (archive_id) REFERENCES archive_items (id) ON DELETE CASCADE
  -- No FK to users: archive outlives deleted users.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE retention_policies (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(200)    NOT NULL,
  target        ENUM('archive','mailbox_folder') NOT NULL,
  scope         ENUM('all','domain','group','user') NOT NULL DEFAULT 'all',
  scope_id      BIGINT UNSIGNED NULL,
  special_use   ENUM('inbox','sent','drafts','trash','junk','archive','outbox') NULL,
  keep_days     INT UNSIGNED    NOT NULL,
  is_enabled    TINYINT(1)      NOT NULL DEFAULT 1,
  created_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE archive_exports (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requested_by  BIGINT UNSIGNED NOT NULL,
  criteria      JSON            NOT NULL,
  format        ENUM('eml_zip','mbox') NOT NULL,
  status        ENUM('pending','running','done','failed','expired') NOT NULL DEFAULT 'pending',
  item_count    INT UNSIGNED    NULL,
  file_path     VARCHAR(500)    NULL,
  sha256        CHAR(64)        NULL,
  error         VARCHAR(1000)   NULL,
  created_at    DATETIME(3)     NOT NULL,
  finished_at   DATETIME(3)     NULL,
  expires_at    DATETIME(3)     NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 9. Backup and restore
-- -----------------------------------------------------------------------------

CREATE TABLE backup_targets (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name         VARCHAR(100)    NOT NULL,
  kind         ENUM('local','smb','nfs','usb','s3','ftp','sftp') NOT NULL,
  config       JSON            NOT NULL,                   -- path, host, share, bucket, region...
  secret       VARBINARY(2048) NULL,                       -- AES-GCM envelope
  encrypt_backups TINYINT(1)   NOT NULL DEFAULT 1,
  is_enabled   TINYINT(1)      NOT NULL DEFAULT 1,
  last_check_at DATETIME(3)    NULL,
  last_check_ok TINYINT(1)     NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_backup_target_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backup_schedules (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(100)    NOT NULL,
  target_id       BIGINT UNSIGNED NOT NULL,
  kind            ENUM('full','incremental') NOT NULL,
  cron            VARCHAR(100)    NOT NULL,
  keep_full       SMALLINT UNSIGNED NOT NULL DEFAULT 4,
  include_archive TINYINT(1)      NOT NULL DEFAULT 1,
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  created_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_bsched_target FOREIGN KEY (target_id) REFERENCES backup_targets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE backup_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  schedule_id     BIGINT UNSIGNED NULL,                    -- NULL = manual / pre-update
  target_id       BIGINT UNSIGNED NOT NULL,
  kind            ENUM('full','incremental','pre_update') NOT NULL,
  base_run_id     BIGINT UNSIGNED NULL,                    -- incremental chain parent
  status          ENUM('running','ok','failed','verifying','verified','corrupt') NOT NULL,
  started_at      DATETIME(3)     NOT NULL,
  finished_at     DATETIME(3)     NULL,
  app_version     VARCHAR(32)     NOT NULL,
  schema_version  INT UNSIGNED    NOT NULL,
  -- Highest messages.id included; next incremental copies ids above it.
  high_message_id BIGINT UNSIGNED NULL,
  file_count      INT UNSIGNED    NULL,
  bytes           BIGINT UNSIGNED NULL,
  manifest_path   VARCHAR(500)    NULL,
  manifest_sha256 CHAR(64)        NULL,
  verified_at     DATETIME(3)     NULL,
  error           TEXT            NULL,
  PRIMARY KEY (id),
  KEY ix_brun_target (target_id, started_at),
  CONSTRAINT fk_brun_target FOREIGN KEY (target_id) REFERENCES backup_targets (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE restore_runs (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  backup_run_id   BIGINT UNSIGNED NOT NULL,
  scope           ENUM('server','user','folder','date_range') NOT NULL,
  criteria        JSON            NOT NULL,
  mode            ENUM('original','restore_folder') NOT NULL DEFAULT 'original',
  status          ENUM('pending','running','ok','failed') NOT NULL DEFAULT 'pending',
  requested_by    BIGINT UNSIGNED NOT NULL,
  items_restored  INT UNSIGNED    NULL,
  started_at      DATETIME(3)     NULL,
  finished_at     DATETIME(3)     NULL,
  error           TEXT            NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_rrun_backup FOREIGN KEY (backup_run_id) REFERENCES backup_runs (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 10. Security: TLS certificates
-- -----------------------------------------------------------------------------

CREATE TABLE tls_certificates (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100)    NOT NULL,
  source        ENUM('self_signed','uploaded') NOT NULL,
  cert_pem      MEDIUMTEXT      NOT NULL,                  -- leaf + chain
  key_secret    VARBINARY(8192) NOT NULL,                  -- AES-GCM envelope of private key PEM
  subject_cn    VARCHAR(255)    NOT NULL,
  san           JSON            NOT NULL,
  not_before    DATETIME(3)     NOT NULL,
  not_after     DATETIME(3)     NOT NULL,
  fingerprint   CHAR(64)        NOT NULL,                  -- SHA-256
  is_active     TINYINT(1)      NOT NULL DEFAULT 0,
  created_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cert_fp (fingerprint)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 11. Logging, auditing, alerts
-- -----------------------------------------------------------------------------

-- Append-only, hash-chained: row_hash = SHA-256(prev_hash || canonical row).
-- The app never UPDATEs/DELETEs; a verifier job detects tampering.
CREATE TABLE audit_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at              DATETIME(3)     NOT NULL,
  actor_user_id   BIGINT UNSIGNED NULL,
  actor_login     VARCHAR(254)    NULL,
  actor_role      VARCHAR(20)     NULL,
  is_support      TINYINT(1)      NOT NULL DEFAULT 0,      -- Vayrone Support actions
  ip              VARCHAR(45)     NULL,
  action          VARCHAR(100)    NOT NULL,                -- 'user.create','relay.update',...
  target_type     VARCHAR(50)     NULL,
  target_id       VARCHAR(100)    NULL,
  details         JSON            NULL,                    -- never contains secrets
  prev_hash       BINARY(32)      NOT NULL,
  row_hash        BINARY(32)      NOT NULL,
  PRIMARY KEY (id),
  KEY ix_audit_at (at),
  KEY ix_audit_actor (actor_user_id, at),
  KEY ix_audit_action (action, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mail_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at              DATETIME(3)     NOT NULL,
  event           VARCHAR(40)     NOT NULL,                -- received, delivered, fetched, queued, relayed, deferred, bounced, rejected, duplicate, rule, spam, virus
  direction       ENUM('in','out','internal') NULL,
  hdr_message_id  VARCHAR(255)    NULL,
  envelope_from   VARCHAR(254)    NULL,
  rcpt            VARCHAR(254)    NULL,
  user_id         BIGINT UNSIGNED NULL,
  subject         VARCHAR(255)    NULL,
  size            BIGINT UNSIGNED NULL,
  client_ip       VARCHAR(45)     NULL,
  ref_type        VARCHAR(30)     NULL,                    -- 'queue','item','fetch_run'
  ref_id          BIGINT UNSIGNED NULL,
  detail          VARCHAR(1000)   NULL,
  PRIMARY KEY (id),
  KEY ix_maillog_at (at),
  KEY ix_maillog_user (user_id, at),
  KEY ix_maillog_msgid (hdr_message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_alerts (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  severity         ENUM('info','warning','critical') NOT NULL,
  code             VARCHAR(60)     NOT NULL,               -- 'disk.low','backup.failed','license.grace',...
  message          VARCHAR(1000)   NOT NULL,
  dedupe_key       VARCHAR(200)    NULL,
  first_at         DATETIME(3)     NOT NULL,
  last_at          DATETIME(3)     NOT NULL,
  occurrences      INT UNSIGNED    NOT NULL DEFAULT 1,
  acknowledged_by  BIGINT UNSIGNED NULL,
  acknowledged_at  DATETIME(3)     NULL,
  resolved_at      DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_alert_dedupe (dedupe_key),
  KEY ix_alert_open (resolved_at, severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 12. Licensing (cache of the signed licence file; the file + signature is the
--     source of truth, these rows are never trusted on their own)
-- -----------------------------------------------------------------------------

CREATE TABLE license_state (
  id                   TINYINT UNSIGNED NOT NULL,
  license_id           VARCHAR(64)      NULL,
  license_blob         MEDIUMTEXT       NULL,               -- signed JSON exactly as issued
  plan                 VARCHAR(50)      NULL,
  max_users            INT UNSIGNED     NULL,
  max_external_accounts INT UNSIGNED    NULL,
  features             JSON             NULL,
  issued_at            DATETIME(3)      NULL,
  expires_at           DATETIME(3)      NULL,
  amc_expires_at       DATETIME(3)      NULL,
  machine_fingerprint  CHAR(64)         NULL,
  activation_mode      ENUM('online','offline') NULL,
  activated_at         DATETIME(3)      NULL,
  last_validated_at    DATETIME(3)      NULL,
  next_validation_due  DATETIME(3)      NULL,
  -- Clock-rollback guard: highest wall-clock time ever observed. If now() is
  -- materially below this, the licence enters 'tampered' state.
  high_water_clock     DATETIME(3)      NULL,
  grace_started_at     DATETIME(3)      NULL,
  status               ENUM('unlicensed','active','grace','expired','tampered','fingerprint_mismatch') NOT NULL DEFAULT 'unlicensed',
  updated_at           DATETIME(3)      NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_license_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE license_events (
  id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at        DATETIME(3)     NOT NULL,
  event     VARCHAR(50)     NOT NULL,                       -- activated, heartbeat_ok, heartbeat_fail, offline_request, offline_import, grace_start, expired, tamper, limit_block
  detail    JSON            NULL,
  PRIMARY KEY (id),
  KEY ix_licevt_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 13. Updates
-- -----------------------------------------------------------------------------

CREATE TABLE update_history (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  from_version      VARCHAR(32)     NOT NULL,
  to_version        VARCHAR(32)     NOT NULL,
  channel           ENUM('stable','beta','offline') NOT NULL,
  package_sha256    CHAR(64)        NOT NULL,
  status            ENUM('downloading','verifying','backing_up','migrating','installed','rolled_back','failed') NOT NULL,
  pre_backup_run_id BIGINT UNSIGNED NULL,
  started_by        BIGINT UNSIGNED NULL,
  started_at        DATETIME(3)     NOT NULL,
  finished_at       DATETIME(3)     NULL,
  log               MEDIUMTEXT      NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
