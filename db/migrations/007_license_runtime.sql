-- =============================================================================
-- 007_license_runtime.sql
-- Licensing runtime (Phase 8). The signed licence blob stays the source of
-- truth; these columns hold what the product needs between restarts:
--   state_seal       AES-256-GCM sealed runtime state (install date, clock
--                    high-water mark, hardware-change date). Sealed with the
--                    master key, so editing the DB cannot rewind it.
--   secret_seal      sealed licence key + online activation token
--   revocation_blob  signed revocation/transfer notice from the License Server
-- =============================================================================

ALTER TABLE license_state
  ADD COLUMN key_hint             VARCHAR(10)      NULL AFTER license_id,
  ADD COLUMN client_name          VARCHAR(200)     NULL AFTER key_hint,
  ADD COLUMN check_by             DATETIME(3)      NULL AFTER amc_expires_at,
  ADD COLUMN revocation_blob      MEDIUMTEXT       NULL AFTER license_blob,
  ADD COLUMN state_seal           VARBINARY(2048)  NULL AFTER revocation_blob,
  ADD COLUMN secret_seal          VARBINARY(1024)  NULL AFTER state_seal,
  ADD COLUMN reason               VARCHAR(500)     NULL AFTER status,
  ADD COLUMN last_heartbeat_at    DATETIME(3)      NULL AFTER last_validated_at,
  ADD COLUMN last_heartbeat_error VARCHAR(500)     NULL AFTER last_heartbeat_at,
  ADD COLUMN heartbeat_failures   INT UNSIGNED     NOT NULL DEFAULT 0 AFTER last_heartbeat_error;
