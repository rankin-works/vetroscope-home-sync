-- Who last wrote the sync_entries row (pushing device), distinct from
-- device_id (where the activity was originally recorded). Pull filters on
-- this so cross-device edits (e.g. tagging another machine's past-day
-- entries) reach the origin device; filtering on device_id alone dropped
-- those updates forever.
ALTER TABLE sync_entries ADD COLUMN updated_by_device_id TEXT;

UPDATE sync_entries
SET updated_by_device_id = device_id
WHERE updated_by_device_id IS NULL;
