-- Dual-wrap sync encryption: a server-held wrap for sign-in recovery
-- alongside the recovery-code wrap for end-to-end mode.
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
