-- Latest health report of each activated client server (hourly from PostMaster 0.6.6+, and with
-- the daily heartbeat): status, plain-language issues and a few figures. Shown on the
-- "Client servers" overview. No mail content, addresses or names are reported.
ALTER TABLE activations
  ADD COLUMN health    JSON        NULL AFTER site,
  ADD COLUMN health_at DATETIME(3) NULL AFTER health;
