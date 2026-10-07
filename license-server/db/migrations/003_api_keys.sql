-- API keys for other Vayrone systems (e.g. the website admin panel) to call the
-- staff API with "Authorization: Bearer vls_…". Only a SHA-256 of the key is stored;
-- the key is shown once when created. A key acts with the staff role (never owner).
CREATE TABLE api_keys (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100)    NOT NULL,
  prefix        CHAR(12)        NOT NULL,              -- first characters, to recognise the key in lists and logs
  key_hash      CHAR(64)        NOT NULL,
  created_by    BIGINT UNSIGNED NOT NULL,              -- owner who created it; recorded as the actor of its actions
  created_at    DATETIME(3)     NOT NULL,
  last_used_at  DATETIME(3)     NULL,
  last_used_ip  VARCHAR(45)     NULL,
  revoked_at    DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_api_key_hash (key_hash),
  CONSTRAINT fk_api_key_user FOREIGN KEY (created_by) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
