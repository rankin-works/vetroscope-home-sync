-- SPDX-License-Identifier: Apache-2.0
-- A tag merged away as a duplicate name is pushed as a tombstone that names
-- the tag it was merged into. Stored and returned so other devices repoint
-- references to the surviving tag instead of treating the merge as a plain
-- delete (which untags its entries until the surviving tag's own row
-- arrives). NULL for ordinary deletes and for older clients.

ALTER TABLE sync_tags ADD COLUMN merged_into_uuid TEXT;
