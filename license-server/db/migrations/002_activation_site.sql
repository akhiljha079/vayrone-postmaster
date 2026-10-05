-- Client details entered in the product's setup wizard, sent with activation,
-- heartbeat and offline requests (latest value per activation).
ALTER TABLE activations ADD COLUMN site JSON NULL AFTER hostname;
