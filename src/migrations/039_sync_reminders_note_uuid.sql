-- SPDX-License-Identifier: Apache-2.0
-- An alert can belong to a note (an alert made from the note's page). The
-- note's uuid is cleartext, like the other uuids. Clients send "" for "no
-- note"; a push without the key (an older client) keeps the stored value.

ALTER TABLE sync_reminders ADD COLUMN note_uuid TEXT;
