-- SPDX-License-Identifier: Apache-2.0
-- Track the Vetroscope app version each device last authenticated with.
-- Updated on every login / register / refresh / setup so the server can
-- gate sync access by client version (the new 426 Upgrade Required path
-- on /sync/push and /sync/pull lives next door) and admin tooling can
-- answer "what version is this device on?" without round-tripping.
--
-- Plaintext (non-PII; admins need to read it). The column is part of the
-- device-row shape the client expects, so it stays stable on the wire.
--
-- Existing rows backfill to NULL — clients send the version on every
-- token-issuing request, so the column populates on its own as devices
-- re-auth.

ALTER TABLE devices ADD COLUMN app_version TEXT;
