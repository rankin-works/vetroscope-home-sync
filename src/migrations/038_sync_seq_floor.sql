-- SPDX-License-Identifier: Apache-2.0
-- The highest seq ever handed out in each seq-numbered table, kept apart
-- from the rows themselves.
--
-- A new row's seq was MAX(seq) + 1 over the table, so deleting rows (Reset
-- Cloud Data, a removed icon or override, a deleted account) could lower
-- the counter: on a server with one account it fell back to 0. The other
-- desktops kept their cursors, which were now ahead of every new number,
-- and pulled nothing until the counter passed them again.
--
-- Before any delete from one of these tables, the table's MAX(seq) is
-- recorded here (keeping the larger value), and every new number starts
-- above both (lib/seq.ts). A table with no row here has never lost rows.

CREATE TABLE IF NOT EXISTS sync_seq_floor (
  tbl TEXT PRIMARY KEY,
  seq INTEGER NOT NULL
);
