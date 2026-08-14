-- SPDX-License-Identifier: Apache-2.0
-- Additive folder color (cleartext palette hex), same shape as marker
-- colors. name stays ciphertext; color is a UI swatch, not PII.
-- Pre-031 servers ignore the field on push and omit it on pull.

ALTER TABLE sync_note_folders ADD COLUMN color TEXT;
