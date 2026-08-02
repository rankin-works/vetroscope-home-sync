-- SPDX-License-Identifier: Apache-2.0
-- Indexed locator for invite codes.
--
-- consumeInvite() had no way to find a candidate row: each invite carries
-- its own salt, so matching a submitted code meant deriving PBKDF2 against
-- every outstanding invite in turn. That makes an unauthenticated
-- registration attempt cost O(open invites) key derivations.
--
-- token_lookup is SHA-256 of the code — fast, unsalted, indexed — and is
-- used only to select the candidate row. The PBKDF2 hash in token_hash is
-- still what actually authorizes the invite, so the fast digest never
-- decides anything on its own. Codes are 60-bit server-generated random,
-- and anyone who can read this column can already read token_hash and every
-- other row in the database.
--
-- Nullable with no backfill: the salted hash is one-way, so existing codes
-- can't be re-derived. Those rows keep using the scan path until they are
-- consumed or expire (30 days at most).
ALTER TABLE invites ADD COLUMN token_lookup TEXT;
CREATE INDEX IF NOT EXISTS idx_invites_token_lookup ON invites(token_lookup);
