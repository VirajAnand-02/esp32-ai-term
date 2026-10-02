-- AI-TERM server schema.
-- All access goes through the server with the secret key, so RLS is enabled
-- with no policies: the publishable key (and anon/authenticated roles) can't
-- read or write anything.

create table if not exists devices (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  kind         text not null default 'esp32' check (kind in ('esp32', 'web', 'cli', 'other')),
  hostname     text,
  token_hash   text unique,
  firmware     text,
  hw           text,
  ip           text,
  status       text not null default 'offline' check (status in ('online', 'offline')),
  last_seen_at timestamptz,
  config       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  device_id     uuid not null references devices (id) on delete cascade,
  title         text,
  model         text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0
);
create index if not exists sessions_device_started_idx on sessions (device_id, started_at desc);
create index if not exists sessions_started_idx on sessions (started_at desc);

create table if not exists messages (
  id         bigint generated always as identity primary key,
  session_id uuid not null references sessions (id) on delete cascade,
  device_id  uuid not null references devices (id) on delete cascade,
  role       text not null check (role in ('system', 'user', 'assistant')),
  content    text not null,
  tokens     integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists messages_session_idx on messages (session_id, created_at);

create table if not exists events (
  id         bigint generated always as identity primary key,
  device_id  uuid references devices (id) on delete cascade,
  type       text not null check (type in ('connect', 'disconnect', 'chat', 'command', 'action', 'log', 'error')),
  level      text not null default 'info' check (level in ('debug', 'info', 'warn', 'error')),
  summary    text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_device_created_idx on events (device_id, created_at desc);
create index if not exists events_created_idx on events (created_at desc);

create table if not exists memories (
  id         uuid primary key default gen_random_uuid(),
  device_id  uuid references devices (id) on delete cascade, -- null = global
  content    text not null,
  tags       text[] not null default '{}',
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ─── Stats views (security_invoker so RLS still applies) ──────────────────

create or replace view stats_hourly with (security_invoker = true) as
select
  date_trunc('hour', created_at)                  as hour,
  count(*)                                        as events,
  count(*) filter (where type = 'chat')           as chats,
  count(*) filter (where level = 'error')         as errors
from events
where created_at > now() - interval '24 hours'
group by 1
order by 1;

create or replace view stats_daily with (security_invoker = true) as
select
  d.day,
  coalesce(e.events, 0) as events,
  coalesce(e.errors, 0) as errors,
  coalesce(s.sessions, 0) as sessions,
  coalesce(s.tokens, 0) as tokens
from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as d(day)
left join (
  select date_trunc('day', created_at) as day, count(*) as events, count(*) filter (where level = 'error') as errors
  from events group by 1
) e on e.day = d.day
left join (
  select date_trunc('day', started_at) as day, count(*) as sessions, sum(input_tokens + output_tokens) as tokens
  from sessions group by 1
) s on s.day = d.day
order by d.day;

create or replace view model_usage with (security_invoker = true) as
select
  coalesce(model, 'unknown')            as model,
  count(*)                              as sessions,
  sum(input_tokens + output_tokens)     as tokens
from sessions
where started_at > now() - interval '7 days'
group by 1
order by tokens desc;

-- ─── Access ───────────────────────────────────────────────────────────────

alter table devices  enable row level security;
alter table sessions enable row level security;
alter table messages enable row level security;
alter table events   enable row level security;
alter table memories enable row level security;
alter table settings enable row level security;

revoke all on all tables in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
