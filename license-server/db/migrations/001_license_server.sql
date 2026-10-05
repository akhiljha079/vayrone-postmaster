-- =============================================================================
-- Vayrone License Server — schema 001
-- Separate database from any PostMaster install (hosted by Vayrone).
-- =============================================================================

CREATE TABLE ls_migrations (
  version     INT UNSIGNED  NOT NULL,
  name        VARCHAR(200)  NOT NULL,
  checksum    CHAR(64)      NOT NULL,
  applied_at  DATETIME(3)   NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partners who sell PostMaster with their own keys and quotas.
CREATE TABLE resellers (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(200)    NOT NULL,
  contact_name    VARCHAR(200)    NULL,
  email           VARCHAR(254)    NULL,
  phone           VARCHAR(30)     NULL,
  city            VARCHAR(100)    NULL,
  gstin           VARCHAR(15)     NULL,
  discount_pct    DECIMAL(5,2)    NOT NULL DEFAULT 0,
  quota_licenses  INT UNSIGNED    NULL,                -- NULL = unlimited
  quota_users     INT UNSIGNED    NULL,                -- total licensed users across their licences
  is_enabled      TINYINT(1)      NOT NULL DEFAULT 1,
  notes           TEXT            NULL,
  created_at      DATETIME(3)     NOT NULL,
  updated_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reseller_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staff_users (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email          VARCHAR(254)    NOT NULL,
  name           VARCHAR(200)    NOT NULL,
  password_hash  VARCHAR(255)    NOT NULL,
  role           ENUM('owner','staff','reseller') NOT NULL,
  reseller_id    BIGINT UNSIGNED NULL,
  is_enabled     TINYINT(1)      NOT NULL DEFAULT 1,
  failed_logins  INT UNSIGNED    NOT NULL DEFAULT 0,
  locked_until   DATETIME(3)     NULL,
  last_login_at  DATETIME(3)     NULL,
  created_at     DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_staff_email (email),
  CONSTRAINT fk_staff_reseller FOREIGN KEY (reseller_id) REFERENCES resellers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash    BINARY(32)      NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  ip            VARCHAR(45)     NULL,
  created_at    DATETIME(3)     NOT NULL,
  last_seen_at  DATETIME(3)     NOT NULL,
  expires_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_session_token (token_hash),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES staff_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE clients (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  reseller_id   BIGINT UNSIGNED NULL,
  company       VARCHAR(200)    NOT NULL,
  contact_name  VARCHAR(200)    NULL,
  email         VARCHAR(254)    NULL,
  phone         VARCHAR(30)     NULL,
  whatsapp      VARCHAR(30)     NULL,
  city          VARCHAR(100)    NULL,
  state         VARCHAR(100)    NULL,
  gstin         VARCHAR(15)     NULL,
  address       VARCHAR(500)    NULL,
  notes         TEXT            NULL,
  created_at    DATETIME(3)     NOT NULL,
  updated_at    DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_client_reseller (reseller_id),
  KEY ix_client_company (company),
  CONSTRAINT fk_client_reseller FOREIGN KEY (reseller_id) REFERENCES resellers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Plans and per-user price slabs: slabs = [{"upTo": 25, "pricePerUser": 1200}, {"upTo": null, "pricePerUser": 900}]
CREATE TABLE plans (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                   VARCHAR(40)     NOT NULL,
  name                   VARCHAR(100)    NOT NULL,
  description            VARCHAR(500)    NULL,
  features               JSON            NOT NULL,
  max_external_accounts  INT UNSIGNED    NULL,
  min_users              INT UNSIGNED    NOT NULL DEFAULT 1,
  slabs                  JSON            NOT NULL,
  term_months            INT UNSIGNED    NOT NULL DEFAULT 12,      -- 0 = perpetual
  amc_pct                DECIMAL(5,2)    NOT NULL DEFAULT 20,      -- yearly AMC as % of the licence price
  is_active              TINYINT(1)      NOT NULL DEFAULT 1,
  created_at             DATETIME(3)     NOT NULL,
  updated_at             DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_plan_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE licenses (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id             VARCHAR(32)     NOT NULL,                 -- LIC-2026-000123 (public id)
  license_key            VARCHAR(40)     NOT NULL,                 -- VPM-XXXXX-XXXXX-XXXXX-XXXXX-C
  client_id              BIGINT UNSIGNED NOT NULL,
  reseller_id            BIGINT UNSIGNED NULL,
  plan_id                BIGINT UNSIGNED NOT NULL,
  max_users              INT UNSIGNED    NOT NULL,
  max_external_accounts  INT UNSIGNED    NULL,
  features               JSON            NOT NULL,
  status                 ENUM('active','suspended','revoked') NOT NULL DEFAULT 'active',
  status_reason          VARCHAR(500)    NULL,
  starts_at              DATETIME(3)     NOT NULL,
  expires_at             DATETIME(3)     NULL,                     -- NULL = perpetual
  amc_expires_at         DATETIME(3)     NULL,
  max_activations        INT UNSIGNED    NOT NULL DEFAULT 1,
  heartbeat_hours        INT UNSIGNED    NOT NULL DEFAULT 24,
  online_check_days      INT UNSIGNED    NOT NULL DEFAULT 30,
  offline_check_days     INT UNSIGNED    NOT NULL DEFAULT 90,
  notes                  TEXT            NULL,
  created_by             BIGINT UNSIGNED NULL,
  created_at             DATETIME(3)     NOT NULL,
  updated_at             DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_license_id (license_id),
  UNIQUE KEY uq_license_key (license_key),
  KEY ix_license_client (client_id),
  KEY ix_license_reseller (reseller_id),
  KEY ix_license_expiry (status, expires_at),
  KEY ix_license_amc (status, amc_expires_at),
  CONSTRAINT fk_license_client FOREIGN KEY (client_id) REFERENCES clients (id),
  CONSTRAINT fk_license_reseller FOREIGN KEY (reseller_id) REFERENCES resellers (id),
  CONSTRAINT fk_license_plan FOREIGN KEY (plan_id) REFERENCES plans (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per machine a licence is (or was) activated on.
CREATE TABLE activations (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  activation_id      VARCHAR(32)     NOT NULL,                     -- ACT-… (public id, in the licence file)
  license_id         BIGINT UNSIGNED NOT NULL,
  machine_id         VARCHAR(32)     NOT NULL,
  components         JSON            NOT NULL,
  mode               ENUM('online','offline') NOT NULL,
  token_hash         BINARY(32)      NULL,                         -- online only
  status             ENUM('active','released') NOT NULL DEFAULT 'active',
  activated_at       DATETIME(3)     NOT NULL,
  last_seen_at       DATETIME(3)     NOT NULL,
  last_ip            VARCHAR(45)     NULL,
  product_version    VARCHAR(32)     NULL,
  install_id         VARCHAR(64)     NULL,
  hostname           VARCHAR(253)    NULL,
  active_users       INT UNSIGNED    NULL,
  external_accounts  INT UNSIGNED    NULL,
  released_at        DATETIME(3)     NULL,
  release_reason     VARCHAR(200)    NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_activation_id (activation_id),
  KEY ix_act_license (license_id, status),
  KEY ix_act_seen (status, last_seen_at),
  CONSTRAINT fk_act_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sales history: new licences, renewals, AMC, upgrades.
CREATE TABLE renewals (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id   BIGINT UNSIGNED NOT NULL,
  kind         ENUM('new','renewal','amc','upgrade') NOT NULL,
  period_from  DATETIME(3)     NULL,
  period_to    DATETIME(3)     NULL,
  users        INT UNSIGNED    NULL,
  amount       DECIMAL(12,2)   NOT NULL DEFAULT 0,
  currency     CHAR(3)         NOT NULL DEFAULT 'INR',
  invoice_ref  VARCHAR(100)    NULL,
  notes        VARCHAR(500)    NULL,
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  KEY ix_renewal_license (license_id),
  KEY ix_renewal_created (created_at),
  CONSTRAINT fk_renewal_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activation log and admin audit trail.
CREATE TABLE events (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  at             DATETIME(3)     NOT NULL,
  license_id     BIGINT UNSIGNED NULL,
  activation_id  BIGINT UNSIGNED NULL,
  actor_user_id  BIGINT UNSIGNED NULL,
  kind           VARCHAR(50)     NOT NULL,     -- activate, heartbeat_mismatch, deactivate, offline_issue, transfer, renew, suspend, ...
  ip             VARCHAR(45)     NULL,
  detail         JSON            NULL,
  PRIMARY KEY (id),
  KEY ix_event_license (license_id, at),
  KEY ix_event_kind (kind, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Daily usage per licence (from heartbeats and offline requests).
CREATE TABLE usage_daily (
  day                DATE            NOT NULL,
  license_id         BIGINT UNSIGNED NOT NULL,
  active_users       INT UNSIGNED    NOT NULL,
  external_accounts  INT UNSIGNED    NOT NULL,
  product_version    VARCHAR(32)     NULL,
  PRIMARY KEY (day, license_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reminders (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id   BIGINT UNSIGNED NOT NULL,
  kind         ENUM('expiry','amc') NOT NULL,
  due_date     DATE            NOT NULL,
  days_before  INT             NOT NULL,                       -- negative = after the date (grace)
  channel      ENUM('email','whatsapp') NOT NULL,
  recipient    VARCHAR(254)    NULL,
  status       ENUM('sent','failed','skipped') NOT NULL,
  error        VARCHAR(500)    NULL,
  sent_at      DATETIME(3)     NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reminder (license_id, kind, due_date, days_before, channel),
  KEY ix_reminder_sent (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  name        VARCHAR(50)  NOT NULL,
  value       JSON         NOT NULL,
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE id_counters (
  name   VARCHAR(20)     NOT NULL,
  value  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
