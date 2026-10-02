-- Memories became a read path.
--
-- The table has existed since 0001 but nothing ever read it: the dashboard listed
-- every row once per page view and the agent never looked at all. It is now read on
-- every single turn, filtered to the enabled rows for one device plus the global
-- ones, so it wants the index it never needed before.
--
-- Partial on `enabled`, because the disabled rows are only ever wanted by the
-- dashboard, which fetches the lot unfiltered anyway.

create index if not exists memories_scope_idx
  on memories (device_id, created_at desc)
  where enabled;
