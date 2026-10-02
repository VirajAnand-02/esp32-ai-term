-- Agent mode: tool calls made on devices, and where each prompt came from.

alter table messages add column if not exists origin text not null default 'device'
  check (origin in ('device', 'web'));

create table if not exists tool_calls (
  id          text primary key,                 -- the AI SDK tool call id
  session_id  uuid not null references sessions (id) on delete cascade,
  device_id   uuid not null references devices (id) on delete cascade,
  name        text not null,
  args        jsonb not null default '{}'::jsonb,
  risk        text,
  status      text not null default 'running'
              check (status in ('running', 'awaiting_approval', 'ok', 'error', 'denied')),
  reason      text,                             -- why approval was needed, or why it was denied
  output      text,                             -- truncated
  decided_by  text,                             -- policy | device | web | timeout
  created_at  timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists tool_calls_session_idx on tool_calls (session_id, created_at);
create index if not exists tool_calls_device_idx on tool_calls (device_id, created_at desc);

alter table tool_calls enable row level security;
revoke all on tool_calls from anon, authenticated;
grant all on tool_calls to service_role;
