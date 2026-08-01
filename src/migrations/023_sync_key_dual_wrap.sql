-- Dual-wrap sync encryption (parity with Cloud migration 045).
-- Existing recovery-code wraps stay in e2ee mode.

ALTER TABLE users ADD COLUMN sync_key_server_wrap TEXT;
ALTER TABLE users ADD COLUMN sync_key_e2ee_wrap TEXT;
ALTER TABLE users ADD COLUMN encryption_mode TEXT NOT NULL DEFAULT 'default';

UPDATE users
SET
  sync_key_e2ee_wrap = encrypted_sync_key,
  encryption_mode = 'e2ee'
WHERE encrypted_sync_key IS NOT NULL
  AND encrypted_sync_key != '';
